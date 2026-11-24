import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Festschreiben und Abruf von PDF und XML über die REST-API (Fork DohmeyerSystems): dieselbe Funktion wie der Knopf in
 * Haben, mit der Rückfrage zur Kleinunternehmergrenze als 409.
 */
describe.skipIf(!testDatabaseUrl)("REST-API: Rechnungen festschreiben und abrufen (Postgres)", () => {
  let api: typeof import("./index.ts");
  let mcp: typeof import("../mcp/index.ts");
  let mcpServer: typeof import("../mcp/server.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());

  beforeAll(async () => {
    sql = await setupTestDb();
    await sql`insert into "user"(id,name,email,role) values (${actor}, 'Testinhaber', 'inhaber@example.de', 'inhaber')`;
    api = await import("./index.ts");
    mcp = await import("../mcp/index.ts");
    mcpServer = await import("../mcp/server.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    mcpServer.resetRateLimitForTests();
    await leeren(sql)`truncate mcp_calls, mcp_tokens, journal_lines, journal_entries, invoice_lines, invoice_taxes, invoices, invoice_number_counters,
      contact_versions, contacts, articles, units, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, ust_id, bundesland, iban, bic, bank)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'DE123456789', 'BY',
              'DE89370400440532013000', 'COBADEFFXXX', 'Commerzbank')`;
  });

  type Scope = import("../mcp/index.ts").TokenScope;
  type Json = Record<string, unknown> & { error?: { code: string; message: string; umsatzgrenze?: Record<string, number> } };

  async function token(scopes: Scope[]) {
    await mcp.setMcpEnabled(actor, true);
    return (await mcp.createMcpToken({ name: "SpectraHost", days: 30, scopes }, new Date(), actor)).token;
  }

  function request(tokenValue: string, method: string, path: string, body?: unknown) {
    return api.handleApiRequest(
      new Request(`http://localhost:3000/api/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${tokenValue}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }

  async function call(tokenValue: string, method: string, path: string, body?: unknown) {
    const response = await request(tokenValue, method, path, body);
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: text ? (JSON.parse(text) as Json) : null };
  }

  const kunde = { name: "Hosting-Kunde Max Muster", strasse: "Lindenweg 3", plz: "10115", ort: "Berlin", email: "max@example.com" };

  /** Entwurf über die API, wie ihn SpectraHost anlegt */
  async function entwurf(t: string, unitPrice = 1_000, taxRate = 1900) {
    const contact = (await call(t, "POST", "/kontakte", kunde)).json!;
    const created = await call(t, "POST", "/rechnungen", {
      contactId: contact.id,
      issueDate: today,
      externalSource: "spectrahost",
      externalId: "inv-1",
      lines: [{ description: "Webhosting Paket M, 1 Monat", quantity: 1000, unit: "Monat", unitPrice, taxRate }],
    });
    expect(created.status).toBe(201);
    return created.json!.id as string;
  }

  const SCOPES: Scope[] = ["kontakte:schreiben", "rechnungen:festschreiben"];

  describe("POST /rechnungen/{id}/festschreiben", () => {
    it("schreibt einen Entwurf fest: Nummer, Sperre und Buchung wie der Knopf in Haben", async () => {
      const t = await token(SCOPES);
      const id = await entwurf(t);
      const response = await call(t, "POST", `/rechnungen/${id}/festschreiben`);
      expect(response.status).toBe(200);
      expect(response.json).toMatchObject({ id, status: "final", externalSource: "spectrahost", externalId: "inv-1", gross: 1_190 });
      expect(response.json!.number).toEqual(expect.any(String));
      expect(response.json!.lockedAt).toEqual(expect.any(String));
      const [row] = await sql`select status, number from invoices where id = ${id}`;
      expect(row).toMatchObject({ status: "final", number: response.json!.number });
      expect(await sql`select 1 from journal_entries`).not.toHaveLength(0);
      // Das Token steht als Akteur im Audit-Log
      const [audit] = await sql`select actor from audit_log where table_name = 'invoices' and row_id = ${id} order by id desc limit 1`;
      expect(audit!.actor).toMatch(/^api:.+:SpectraHost$/);
    });

    it("schreibt nie zweimal fest: ein zweiter Aufruf endet mit 409 und behält die Nummer", async () => {
      const t = await token(SCOPES);
      const id = await entwurf(t);
      const first = await call(t, "POST", `/rechnungen/${id}/festschreiben`);
      const second = await call(t, "POST", `/rechnungen/${id}/festschreiben`);
      expect(second.status).toBe(409);
      expect(second.json!.error).toMatchObject({ code: "conflict" });
      expect(second.json!.error!.message).toMatch(/festgeschrieben/);
      expect(await sql`select number from invoices where id = ${id}`).toEqual([{ number: first.json!.number }]);
    });

    it("gleichzeitige Aufrufe ziehen genau eine Nummer", async () => {
      const t = await token(SCOPES);
      const id = await entwurf(t);
      const results = await Promise.all([1, 2, 3].map(() => call(t, "POST", `/rechnungen/${id}/festschreiben`)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      // Der Zähler des Nummernkreises steht auf 1: Die Verlierer haben keine Nummer gezogen
      expect(await sql`select last from invoice_number_counters`).toEqual([{ last: 1 }]);
    });

    it("nennt mit 422, was zum Festschreiben fehlt, und lässt den Entwurf stehen", async () => {
      const t = await token(SCOPES);
      const id = await entwurf(t);
      await sql`update company set steuernummer = '', ust_id = '' where id = 1`;
      const response = await call(t, "POST", `/rechnungen/${id}/festschreiben`);
      expect(response.status).toBe(422);
      expect(response.json!.error).toMatchObject({ code: "unprocessable" });
      expect(response.json!.error!.message).toMatch(/Noch nicht bereit.*Firmendaten/);
      expect(await sql`select status, number from invoices where id = ${id}`).toEqual([{ status: "draft", number: null }]);
    });

    it("unbekannte Rechnung 404", async () => {
      const t = await token(SCOPES);
      expect((await call(t, "POST", "/rechnungen/00000000-0000-4000-8000-000000000000/festschreiben")).status).toBe(404);
    });

    it("verlangt das Recht rechnungen:festschreiben; es schließt Entwürfe und Lesen ein", async () => {
      const entwuerfe = await token(["kontakte:schreiben", "rechnungen:entwuerfe"]);
      const id = await entwurf(entwuerfe);
      const denied = await call(entwuerfe, "POST", `/rechnungen/${id}/festschreiben`);
      expect(denied.status).toBe(403);
      expect(denied.json!.error!.message).toMatch(/rechnungen:festschreiben/);

      const t = await token(["rechnungen:festschreiben"]);
      expect((await call(t, "GET", `/rechnungen/${id}`)).status).toBe(200);
      expect((await call(t, "PATCH", `/rechnungen/${id}`, { note: "Danke!" })).status).toBe(200);
    });

    it("lehnt unbekannte Felder im Body ab", async () => {
      const t = await token(SCOPES);
      const id = await entwurf(t);
      expect((await call(t, "POST", `/rechnungen/${id}/festschreiben`, { nummer: "2026-1" })).status).toBe(400);
    });

    describe("Kleinunternehmergrenze", () => {
      async function kleinunternehmerEntwurf(t: string) {
        await sql`update company set kleinunternehmer = true where id = 1`;
        // 120.000 € netto liegt über jeder Jahresgrenze nach § 19 UStG
        return entwurf(t, 12_000_000, 0);
      }

      it("schreibt über der Grenze nicht fest, sondern meldet 409 umsatzgrenze mit den Werten", async () => {
        const t = await token(SCOPES);
        const id = await kleinunternehmerEntwurf(t);
        const response = await call(t, "POST", `/rechnungen/${id}/festschreiben`);
        expect(response.status).toBe(409);
        expect(response.json!.error).toMatchObject({ code: "umsatzgrenze" });
        expect(response.json!.error!.message).toMatch(/Kleinunternehmergrenze/);
        expect(response.json!.error!.umsatzgrenze).toMatchObject({ umsatz: expect.any(Number), rechnung: 12_000_000, grenze: expect.any(Number) });
        expect(await sql`select status from invoices where id = ${id}`).toEqual([{ status: "draft" }]);
      });

      it("schreibt erst mit der Bestätigung genau der gemeldeten Werte fest", async () => {
        const t = await token(SCOPES);
        const id = await kleinunternehmerEntwurf(t);
        const warning = (await call(t, "POST", `/rechnungen/${id}/festschreiben`)).json!.error!.umsatzgrenze!;
        const wrong = await call(t, "POST", `/rechnungen/${id}/festschreiben`, { bestaetigt: { ...warning, rechnung: warning.rechnung! + 1 } });
        expect(wrong.status).toBe(409);
        expect(wrong.json!.error).toMatchObject({ code: "umsatzgrenze" });
        const confirmed = await call(t, "POST", `/rechnungen/${id}/festschreiben`, { bestaetigt: warning });
        expect(confirmed.status).toBe(200);
        expect(confirmed.json).toMatchObject({ id, status: "final" });
      });
    });
  });

  describe("GET /rechnungen/{id}/pdf und /xml", () => {
    it("liefert PDF und XML der festgeschriebenen Rechnung mit rechnungen:lesen", async () => {
      const t = await token(SCOPES);
      const id = await entwurf(t);
      const number = (await call(t, "POST", `/rechnungen/${id}/festschreiben`)).json!.number as string;
      const lesen = await token(["rechnungen:lesen"]);

      const pdf = await request(lesen, "GET", `/rechnungen/${id}/pdf`);
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get("content-type")).toBe("application/pdf");
      expect(pdf.headers.get("content-disposition")).toContain(encodeURIComponent(`Rechnung-${number}.pdf`));
      const bytes = new Uint8Array(await pdf.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
      const [stored] = await sql`select pdf from invoices where id = ${id}`;
      expect(Buffer.from(bytes).equals(Buffer.from(stored!.pdf as Uint8Array))).toBe(true);

      const xml = await request(lesen, "GET", `/rechnungen/${id}/xml`);
      expect(xml.status).toBe(200);
      expect(xml.headers.get("content-type")).toMatch(/^application\/xml/);
      expect(await xml.text()).toContain(number);
    });

    it("zu einem Entwurf gibt es keine Datei: 404", async () => {
      const t = await token(SCOPES);
      const id = await entwurf(t);
      for (const datei of ["pdf", "xml"]) {
        const response = await call(t, "GET", `/rechnungen/${id}/${datei}`);
        expect(response.status).toBe(404);
        expect(response.json!.error).toMatchObject({ code: "not_found" });
      }
    });

    it("verlangt rechnungen:lesen", async () => {
      const t = await token(["kontakte:lesen"]);
      expect((await call(t, "GET", "/rechnungen/00000000-0000-4000-8000-000000000000/pdf")).status).toBe(403);
    });
  });
});

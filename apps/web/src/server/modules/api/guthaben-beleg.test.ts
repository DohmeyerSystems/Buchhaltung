import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Beleg über 0 € für eine Leistung, die der Kunde aus seinem Guthaben bezahlt (Fork DohmeyerSystems, SpectraHost): Die
 * Aufladung war schon Umsatz, der Beleg zählt nicht noch einmal. Gekennzeichnet über bereits_bezahlt mit paidVia
 * „Kundenguthaben“; Leistung und Abzug heben sich auf, deshalb bucht das Festschreiben nichts.
 */
describe.skipIf(!testDatabaseUrl)("REST-API: Beleg aus Kundenguthaben (Postgres)", () => {
  let api: typeof import("./index.ts");
  let mcp: typeof import("../mcp/index.ts");
  let mcpServer: typeof import("../mcp/server.ts");
  let rechnungen: typeof import("../rechnungen/index.ts");
  let auswertungen: typeof import("../auswertungen/index.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());

  beforeAll(async () => {
    sql = await setupTestDb();
    await sql`insert into "user"(id,name,email,role) values (${actor}, 'Testinhaber', 'inhaber@example.de', 'inhaber')`;
    api = await import("./index.ts");
    mcp = await import("../mcp/index.ts");
    mcpServer = await import("../mcp/server.ts");
    rechnungen = await import("../rechnungen/index.ts");
    auswertungen = await import("../auswertungen/index.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    mcpServer.resetRateLimitForTests();
    await leeren(sql)`truncate mcp_calls, mcp_tokens, journal_lines, journal_entries, invoice_lines, invoice_taxes, invoices, invoice_number_counters,
      contact_versions, contacts, articles, units, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, iban, bic, bank, kleinunternehmer)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'BY',
              'DE89370400440532013000', 'COBADEFFXXX', 'Commerzbank', true)`;
  });

  type Json = Record<string, unknown> & { error?: { code: string; message: string } };

  async function token() {
    await mcp.setMcpEnabled(actor, true);
    return (await mcp.createMcpToken({ name: "SpectraHost", days: 30, scopes: ["kontakte:schreiben", "rechnungen:festschreiben"] }, new Date(), actor)).token;
  }

  async function call(t: string, method: string, path: string, body?: unknown) {
    const response = await api.handleApiRequest(
      new Request(`http://localhost:3000/api/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${t}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await response.text();
    return { status: response.status, json: text && response.headers.get("content-type")?.includes("json") ? (JSON.parse(text) as Json) : null, text };
  }

  const leistung = { description: "KVM VPS M (1 Monat)", quantity: 1000, unit: "Stk.", unitPrice: 999, taxRate: 0 };
  const abzug = (unitPrice = -999) => ({ description: "Bezahlt aus Kundenguthaben", quantity: 1000, unit: "Psch.", unitPrice, taxRate: 0 });

  const kontakt = async (t: string) => (await call(t, "POST", "/kontakte", { name: "Max Muster", strasse: "Lindenweg 3", plz: "10115", ort: "Berlin" })).json!;

  /** Entwurf, wie ihn SpectraHost für eine Zahlung aus dem Guthaben anlegt */
  async function entwurf(t: string, lines: unknown[] = [leistung, abzug()], paidVia = "Kundenguthaben", externalId = "rechnung-42") {
    const contact = await kontakt(t);
    const created = await call(t, "POST", "/rechnungen", {
      contactId: contact.id,
      issueDate: today,
      serviceFrom: today,
      serviceTo: today,
      lines,
      taxTreatment: "kleinunternehmer",
      priceMode: "brutto",
      paymentMethod: "bereits_bezahlt",
      paidVia,
      paidOn: today,
      externalSource: "spectrahost",
      externalId,
    });
    expect(created.status).toBe(201);
    return created.json!.id as string;
  }

  const journal = async () => (await sql`select count(*)::int as n from journal_entries`)[0]!.n as number;

  it("schreibt den gekennzeichneten Beleg über 0 € fest: Nummer, PDF, keine Buchung, nichts offen", async () => {
    const t = await token();
    const id = await entwurf(t);
    const response = await call(t, "POST", `/rechnungen/${id}/festschreiben`);
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ id, status: "final", gross: 0, open: 0 });
    expect(response.json!.number).toEqual(expect.any(String));
    // Leistung und Abzug heben sich auf: kein Erlös, keine Forderung, keine Buchung
    expect(await journal()).toBe(0);
    const pdf = await call(t, "GET", `/rechnungen/${id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.text.startsWith("%PDF-")).toBe(true);
    expect((await call(t, "GET", `/rechnungen/${id}/xml`)).text).toMatch(/TypeCode>97<|PaymentMeansCode>97</);
    // Dieselbe externe Kennung liefert denselben Beleg
    const again = await call(t, "POST", "/rechnungen", {
      contactId: response.json!.contactId,
      lines: [leistung, abzug()],
      externalSource: "spectrahost",
      externalId: "rechnung-42",
    });
    expect(again.status).toBe(200);
    expect(again.json!.id).toBe(id);
  });

  it("lehnt 0 € ohne Kennzeichnung weiter ab", async () => {
    const t = await token();
    const id = await entwurf(t, [leistung, abzug()], "Stripe");
    const response = await call(t, "POST", `/rechnungen/${id}/festschreiben`);
    expect(response.status).toBe(422);
    expect(response.json!.error).toMatchObject({ code: "unprocessable" });
    expect(response.json!.error!.message).toMatch(/Gesamtbetrag muss positiv sein/);
  });

  it("lehnt eine negative Summe auch mit Kennzeichnung ab", async () => {
    const t = await token();
    const id = await entwurf(t, [leistung, abzug(-1_500)]);
    const response = await call(t, "POST", `/rechnungen/${id}/festschreiben`);
    expect(response.status).toBe(422);
    expect(response.json!.error!.message).toMatch(/Gesamtbetrag muss positiv sein/);
  });

  it("lehnt 0 € aus Kundenguthaben ohne Abzugszeile ab, etwa durch 100 % Rabatt", async () => {
    const contact = await kontakt(await token());
    const draft = await rechnungen.createDraft(
      actor,
      rechnungen.draftSchema.parse({
        contactId: contact.id,
        issueDate: today,
        serviceFrom: null,
        serviceTo: null,
        paymentTermDays: 14,
        format: "zugferd",
        note: "",
        taxTreatment: "kleinunternehmer",
        paymentMethod: "bereits_bezahlt",
        paidVia: "Kundenguthaben",
        paidOn: today,
        lines: [{ ...leistung, discount: { kind: "prozent", value: 10_000 } }],
      }),
    );
    expect(await rechnungen.finalizeIssues(draft.id)).toContainEqual(expect.stringMatching(/Kundenguthaben.*Leistung und eine Abzugszeile/));
  });

  it("lehnt Leistung und Abzug mit verschiedenen Steuersätzen ab, sonst entstünden Erlös und Umsatzsteuer", async () => {
    await sql`update company set kleinunternehmer = false, ust_id = 'DE123456789' where id = 1`;
    const t = await token();
    const contact = await kontakt(t);
    const created = await call(t, "POST", "/rechnungen", {
      contactId: contact.id,
      issueDate: today,
      taxTreatment: "regulaer",
      priceMode: "brutto",
      paymentMethod: "bereits_bezahlt",
      paidVia: "Kundenguthaben",
      paidOn: today,
      lines: [
        { ...leistung, unitPrice: 1_190, taxRate: 1900 },
        { ...abzug(-1_190), taxRate: 700 },
      ],
    });
    expect(created.json!.gross).toBe(0);
    const response = await call(t, "POST", `/rechnungen/${created.json!.id}/festschreiben`);
    expect(response.status).toBe(422);
    expect(response.json!.error!.message).toMatch(/je Steuersatz aufheben/);
    expect(await journal()).toBe(0);
  });

  it("fragt nie nach der Kleinunternehmergrenze, auch wenn sie schon überschritten wäre", async () => {
    const t = await token();
    const ueberGrenze = async () => ({ aktuell: { netto: 2_600_000 }, vorjahr: { netto: 0 }, jahresgrenze: 2_500_000, vorjahresgrenzeUeberschritten: false });
    const normal = await entwurf(t, [leistung], "Stripe", "rechnung-41");
    await expect(rechnungen.finalizeInvoice(actor, normal, ueberGrenze)).rejects.toThrow(/Kleinunternehmergrenze/);
    const beleg = await entwurf(t);
    expect((await rechnungen.finalizeInvoice(actor, beleg, ueberGrenze)).status).toBe("final");
  });

  it("lässt sich stornieren, ohne Umsatz zu buchen, auch keinen negativen", async () => {
    const t = await token();
    const id = await entwurf(t);
    const vorher = await auswertungen.kleinunternehmerStand(today, null);
    expect((await call(t, "POST", `/rechnungen/${id}/festschreiben`)).status).toBe(200);
    const storno = await rechnungen.cancelInvoice(actor, id, today);
    expect(storno).toMatchObject({ kind: "storno", status: "final", gross: 0 });
    expect(await journal()).toBe(0);
    expect(await auswertungen.kleinunternehmerStand(today, null)).toEqual(vorher);
  });
});

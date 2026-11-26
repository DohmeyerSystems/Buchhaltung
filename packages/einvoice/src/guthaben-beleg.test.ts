import { describe, expect, it } from "vitest";
import { pdfData } from "./pdf.ts";
import { sampleDocument } from "./samples.ts";
import { validateForFormat } from "./validate.ts";
import { buildEInvoice } from "./xml.ts";

/*
 * Beleg über 0 €, bezahlt aus dem Kundenguthaben (Fork DohmeyerSystems, SpectraHost): Leistung und Abzug heben sich auf.
 * Statt „keine Zahlung erforderlich“ nennt er die Zahlung aus dem Guthaben, ohne Bankverbindung, Frist und GiroCode.
 */
const lines = [
  { description: "KVM VPS M (1 Monat)", quantity: 1000, unit: "Stk.", unitPrice: 999, taxRate: 0 },
  { description: "Bezahlt aus Kundenguthaben", quantity: 1000, unit: "Psch.", unitPrice: -999, taxRate: 0 },
];
const guthabenBeleg = (format?: "zugferd" | "xrechnung-cii" | "xrechnung-ubl") => ({
  ...sampleDocument({ lines, taxTreatment: "kleinunternehmer", ...(format ? { format } : {}) }),
  paidPayment: { paidVia: "Kundenguthaben", paidOn: "2026-11-26" },
});

describe("Beleg aus Kundenguthaben (0 €)", () => {
  it("nennt die Zahlung aus dem Guthaben und zeigt weder GiroCode noch IBAN", () => {
    const doc = guthabenBeleg();
    expect(doc.totals.gross).toBe(0);
    const de = pdfData(doc);
    expect(de.payment).toBe("Der Betrag wurde am 26.11.2026 aus dem Kundenguthaben bezahlt.");
    expect(pdfData({ ...doc, language: "en" }).payment).toBe("The amount was paid from the customer credit balance on 26 Nov 2026.");
    expect(de.qr).toBeNull();
    expect(de.footer.flat().join(" ")).not.toContain("IBAN");
  });

  it("bleibt bei 0 € mit anderem Zahlungsweg wie bisher: keine Zahlung erforderlich", () => {
    const doc = { ...guthabenBeleg(), paidPayment: { paidVia: "Stripe", paidOn: "2026-11-26" } };
    expect(pdfData(doc).payment).toBe("Es ist keine Zahlung erforderlich.");
  });

  it.each(["zugferd", "xrechnung-cii", "xrechnung-ubl"] as const)("ist in %s gültig, als Verrechnung ohne Frist und Konto", async (format) => {
    const doc = guthabenBeleg(format);
    expect(validateForFormat({ ...doc, seller: { ...doc.seller, iban: "" } })).toEqual([]);
    const { xml } = await buildEInvoice(doc);
    // 97 nach UNTDID 4461: Verrechnung zwischen den Partnern
    expect(xml).toMatch(format === "xrechnung-ubl" ? /<cbc:PaymentMeansCode>97<\/cbc:PaymentMeansCode>/ : /<ram:TypeCode>97<\/ram:TypeCode>/);
    expect(xml).not.toMatch(/DueDate|FinancialAccount|PayeeFinancialAccount/);
    expect(xml).toContain("aus dem Kundenguthaben bezahlt");
  });
});

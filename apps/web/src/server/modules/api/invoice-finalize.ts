import { deliverSoon } from "../ablage/index.ts";
import { kleinunternehmerStand } from "../auswertungen/index.ts";
import { finalizeInvoice, getInvoice, UmsatzgrenzeError } from "../rechnungen/index.ts";
import { fail, notFound, validate, type ApiFile, type ApiRequest, type ApiResult, type Handler } from "./http.ts";
import { INVOICE_NOT_FOUND, respondWith } from "./invoices.ts";
import { finalizeSchema } from "./schemas.ts";

/*
 * Festschreiben und Abruf der Dateien über die REST-API (Fork DohmeyerSystems, für SpectraHost). Festgeschrieben wird mit
 * derselben Funktion wie über den Knopf in Haben: Prüfungen, Nummer, PDF und XML, Sperre und Buchung in einer
 * Transaktion. Die Rückfrage zur Kleinunternehmergrenze kommt als 409 umsatzgrenze; erst ein zweiter Aufruf mit genau
 * diesen Werten in bestaetigt schreibt fest.
 */

const ALREADY_FINAL = "Die Rechnung ist schon festgeschrieben.";

function umsatzgrenze(error: UmsatzgrenzeError): ApiResult {
  const { umsatz, rechnung, grenze, vorjahresumsatz } = error;
  return fail("umsatzgrenze", `${error.message} Über die API: erneut aufrufen mit bestaetigt = error.umsatzgrenze.`, {
    umsatzgrenze: { umsatz, rechnung, grenze, ...(vorjahresumsatz === undefined ? {} : { vorjahresumsatz }) },
  });
}

export async function finalizeInvoiceHandler(request: ApiRequest): Promise<ApiResult> {
  const input = validate(finalizeSchema, request.body ?? {});
  if ("failure" in input) return input.failure;
  const id = request.params.id!;
  const found = await getInvoice(id);
  if (!found) return notFound(INVOICE_NOT_FOUND);
  if (found.invoice.status !== "draft") return fail("conflict", ALREADY_FINAL);
  try {
    await finalizeInvoice(request.actor, id, kleinunternehmerStand, input.data.bestaetigt);
  } catch (error) {
    if (error instanceof UmsatzgrenzeError) return umsatzgrenze(error);
    // Ein gleichzeitiger Aufruf war schneller; die Sperre des Entwurfs hat ihn gewinnen lassen
    if ((await getInvoice(id))?.invoice.status !== "draft") return fail("conflict", ALREADY_FINAL);
    throw error;
  }
  // Wie nach dem Knopf in Haben: gleich ins Dokumentenarchiv, falls eingerichtet
  deliverSoon();
  return respondWith(id, request);
}

/** Das beim Festschreiben gespeicherte PDF bzw. die XML, unverändert; zu einem Entwurf gibt es keine */
export function invoiceFileHandler(datei: "pdf" | "xml"): Handler {
  return async (request) => {
    const invoice = (await getInvoice(request.params.id!))?.invoice;
    if (!invoice) return notFound(INVOICE_NOT_FOUND);
    if (!invoice.number) return notFound("Die Rechnung ist ein Entwurf; PDF und XML gibt es erst nach dem Festschreiben.");
    let file: ApiFile | null = null;
    if (datei === "pdf" && invoice.pdf) {
      file = { bytes: invoice.pdf, mimeType: "application/pdf", filename: `Rechnung-${invoice.number}.pdf` };
    }
    if (datei === "xml" && invoice.xml) {
      const suffix = invoice.format === "xrechnung-ubl" ? "ubl" : "cii";
      file = { bytes: new TextEncoder().encode(invoice.xml), mimeType: "application/xml", filename: `Rechnung-${invoice.number}-${suffix}.xml` };
    }
    if (!file) return notFound(`Zu dieser Rechnung ist keine ${datei === "pdf" ? "PDF-Datei" : "XML"} gespeichert.`);
    return { status: 200, file };
  };
}

import { finalizeInvoiceHandler, invoiceFileHandler } from "./invoice-finalize.ts";
import { createInvoiceHandler, deleteInvoiceHandler, getInvoiceHandler, listInvoicesHandler, updateInvoiceHandler } from "./invoices.ts";
import { createRecurringInvoiceHandler } from "./recurring-invoices.ts";
import type { ApiRoute } from "./routes.ts";
import { invoiceQuerySchema } from "./schemas.ts";

/** Endpunkte unter /rechnungen; routes.ts reiht sie zwischen Kontakte und Angebote ein */
export const INVOICE_ROUTES: ApiRoute[] = [
  {
    method: "GET",
    path: "/rechnungen",
    scope: "rechnungen:lesen",
    tag: "Rechnungen",
    summary: "Rechnungen auflisten",
    description: "Entwürfe zuerst, dann nach Nummer absteigend. Mit externalSource und externalId die Rechnung zu einer Bestellung finden.",
    query: invoiceQuerySchema,
    responses: { 200: { schema: "InvoiceList", description: "Eine Seite Rechnungen" } },
    handler: listInvoicesHandler,
  },
  {
    method: "POST",
    path: "/rechnungen",
    scope: "rechnungen:entwuerfe",
    tag: "Rechnungen",
    summary: "Rechnungsentwurf anlegen",
    description:
      "Legt einen Entwurf an; festgeschrieben wird in Haben. Nicht angegebene Felder nehmen die Vorgaben aus den Firmendaten, Format und Sprache die des Kontakts. " +
      "Mit externalSource und externalId idempotent: Gibt es die Referenz schon, kommt die vorhandene Rechnung unverändert mit 200 zurück.",
    requestBody: "InvoiceDraftCreate",
    responses: {
      201: { schema: "Invoice", description: "Entwurf angelegt; Location zeigt auf ihn" },
      200: { schema: "Invoice", description: "Zu dieser externen Referenz gibt es schon eine Rechnung, sie bleibt unverändert" },
    },
    handler: createInvoiceHandler,
  },
  {
    method: "POST",
    path: "/rechnungen/wiederkehrend",
    scope: "rechnungen:vorlagen-anlegen",
    tag: "Rechnungen",
    summary: "Vorlage für wiederkehrende Rechnungen anlegen",
    description: "Legt eine pausierte Vorlage im Entwurfsmodus an. Prüfung und Aktivierung erfolgen in Haben.",
    requestBody: "RecurringInvoiceCreate",
    responses: { 201: { schema: "RecurringInvoiceCreated", description: "Vorlage angelegt; Location führt zur Vorlage in Haben" } },
    handler: createRecurringInvoiceHandler,
  },
  {
    method: "GET",
    path: "/rechnungen/{id}",
    scope: "rechnungen:lesen",
    tag: "Rechnungen",
    summary: "Rechnung lesen",
    description: "Entwürfe und festgeschriebene Rechnungen, mit Positionen und offenem Betrag.",
    responses: { 200: { schema: "Invoice", description: "Die Rechnung" } },
    handler: getInvoiceHandler,
  },
  {
    method: "PATCH",
    path: "/rechnungen/{id}",
    scope: "rechnungen:entwuerfe",
    tag: "Rechnungen",
    summary: "Rechnungsentwurf ändern",
    description: "Nur solange Entwurf. Nur die genannten Felder ändern sich; lines ersetzt alle Positionen. Die externe Referenz bleibt.",
    requestBody: "InvoiceDraftPatch",
    responses: { 200: { schema: "Invoice", description: "Der geänderte Entwurf" } },
    errors: { 409: "Die Rechnung ist festgeschrieben" },
    handler: updateInvoiceHandler,
  },
  {
    method: "DELETE",
    path: "/rechnungen/{id}",
    scope: "rechnungen:entwuerfe",
    tag: "Rechnungen",
    summary: "Rechnungsentwurf löschen",
    description: "Nur solange Entwurf; danach ist die externe Referenz wieder frei.",
    responses: { 204: { schema: null, description: "Gelöscht" } },
    errors: { 409: "Die Rechnung ist festgeschrieben" },
    handler: deleteInvoiceHandler,
  },
  {
    method: "POST",
    path: "/rechnungen/{id}/festschreiben",
    scope: "rechnungen:festschreiben",
    tag: "Rechnungen",
    summary: "Rechnungsentwurf festschreiben",
    description:
      "Wie der Knopf in Haben: dieselben Prüfungen, dann Nummer, PDF und XML, Sperre und Buchung in einem Schritt. Danach " +
      "nur noch Storno in Haben. Body leer oder {}. Würde die Rechnung die Kleinunternehmergrenze überschreiten, kommt 409 " +
      "mit code umsatzgrenze und den Werten in error.umsatzgrenze; erst ein erneuter Aufruf mit diesen Werten in bestaetigt " +
      "schreibt fest. Fork DohmeyerSystems, nicht in Haben selbst.",
    requestBody: "InvoiceFinalize",
    optionalBody: true,
    responses: { 200: { schema: "Invoice", description: "Die festgeschriebene Rechnung mit Nummer" } },
    errors: {
      409: "Schon festgeschrieben (conflict), oder Rückfrage zur Kleinunternehmergrenze (umsatzgrenze)",
      422: "Noch nicht bereit, z. B. Firmendaten unvollständig; die Meldung nennt die Gründe",
    },
    handler: finalizeInvoiceHandler,
  },
  {
    method: "GET",
    path: "/rechnungen/{id}/pdf",
    scope: "rechnungen:lesen",
    tag: "Rechnungen",
    summary: "PDF einer festgeschriebenen Rechnung",
    description: "Das beim Festschreiben gespeicherte PDF, unverändert, als Download. Zu einem Entwurf 404.",
    responses: { 200: { schema: null, media: "application/pdf", description: "Das PDF" } },
    handler: invoiceFileHandler("pdf"),
  },
  {
    method: "GET",
    path: "/rechnungen/{id}/xml",
    scope: "rechnungen:lesen",
    tag: "Rechnungen",
    summary: "E-Rechnungs-XML einer festgeschriebenen Rechnung",
    description: "Die beim Festschreiben gespeicherte XML (CII oder UBL), unverändert, als Download. Zu einem Entwurf oder ohne XML 404.",
    responses: { 200: { schema: null, media: "application/xml", description: "Die XML" } },
    handler: invoiceFileHandler("xml"),
  },
];

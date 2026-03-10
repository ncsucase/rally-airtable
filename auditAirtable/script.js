// Automation flow:
//   Run Script (this file) → Repeating Group → Run Script (auditRecord/script.js)
//
// This setup script queries Airtable for records that need auditing and passes
// them one-by-one to a Repeating Group. All Rally interaction happens in
// auditRecord/script.js, which runs once per record inside the Repeating Group.

// -----------------------------------------------------------------------------

const CONFIG = {

  airtable: {
    tableId: "tblXXXXXXXXXXXXXX",

    // Field containing the Rally FormattedID (e.g. "F123456", "US789")
    rallyIdFieldId: "fldXXXXXXXXXXXXXX",

    // Source field filter — use when multiple sources share the same ID format (e.g. "F######").
    // When set, only Airtable records where sourceFieldId equals sourceFilterValue are audited.
    // Set sourceFieldId to null to audit all records that have a non-empty Rally ID field.
    sourceFieldId: "fldXXXXXXXXXXXXXX", // single select field identifying the record's source
    sourceFilterValue: "Rally",          // only audit records with this source value

    // Optional extra Airtable formula clause to further filter which records are audited.
    // This is AND'd together with the Rally ID and source field clauses automatically.
    // Example: "NOT({Status} = \"Archived\")"
    // Set to null if no additional filtering is needed.
    filterByFormula: null,
  },

}; // end CONFIG

// --- Airtable fetch ----------------------------------------------------------

async function fetchAirtableRecordsWithRallyId() {
  const { rallyIdFieldId, sourceFieldId, sourceFilterValue, filterByFormula } = CONFIG.airtable;

  const clauses = [];
  clauses.push(`{${rallyIdFieldId}} != ""`);
  if (sourceFieldId) {
    clauses.push(`{${sourceFieldId}} = "${sourceFilterValue}"`);
  }
  if (filterByFormula) {
    clauses.push(filterByFormula);
  }
  const formula = clauses.length === 1 ? clauses[0] : `AND(${clauses.join(", ")})`;

  const fields = [rallyIdFieldId];
  if (sourceFieldId) fields.push(sourceFieldId);

  const table = base.getTable(CONFIG.airtable.tableId);
  const result = await table.selectRecordsAsync({ fields, filterByFormula: formula });

  return result.records.map(r => ({
    id: r.id,
    rallyId: r.getCellValueAsString(rallyIdFieldId).trim(),
  }));
}

// --- Main --------------------------------------------------------------------

async function main() {
  console.log("=== auditAirtable (setup) starting ===");
  console.log("Fetching Airtable records with Rally IDs...");
  const records = await fetchAirtableRecordsWithRallyId();
  console.log(`Found ${records.length} records to audit`);

  if (records.length === 0) {
    console.log("Nothing to audit. Exiting.");
    output.set("auditRecord", []);
    return;
  }

  output.set("auditRecord", records.map(r => JSON.stringify({ airtableId: r.id, rallyId: r.rallyId })));
  console.log(`Passed ${records.length} records to repeating group`);
  console.log("=== auditAirtable (setup) complete ===");
}

await main();

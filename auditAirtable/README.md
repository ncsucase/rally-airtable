# auditAirtable

> **This script has been superseded by [`auditRecord/script.js`](../auditRecord/README.md).**
>
> The original single-step approach fetches all Rally records in bulk and processes them in one execution. On large datasets this can exceed Airtable's script execution time limit. `auditRecord` runs the same check inside a Repeating Group — one lightweight Rally call per record — so there is no timeout risk regardless of dataset size.
>
> See [`auditRecord/README.md`](../auditRecord/README.md) for setup instructions.

---

## Legacy single-step script

`auditAirtable/script.js` is kept here for reference. It compares all Airtable records that originated from Rally against the current Rally record set in a single script execution without a Repeating Group.

Use it only if:
- Your dataset is small enough that the script reliably completes within Airtable's execution time limit, **and**
- You prefer a single-step automation over a Repeating Group setup

For everything else, use `auditRecord`.

## Setup (legacy)

Edit only the `CONFIG` object at the top of the script.

```
CONFIG.airtable.tableId            The Airtable table containing Rally-sourced records
CONFIG.airtable.rallyIdFieldId     Field holding the Rally FormattedID (e.g. "F123456", "US789")
CONFIG.airtable.sourceFieldId      (Optional) Single select field identifying the record's source
CONFIG.airtable.sourceFilterValue  The source value that means "this came from Rally"
CONFIG.airtable.filterByFormula    (Optional) Additional Airtable formula to further filter audited records
```

## How it works (legacy)

1. **Fetch Airtable records** — queries the target table for records where the Rally ID field is non-empty.
2. **Output to Repeating Group** — passes `{ airtableId, rallyId }` for each record via `output.set("auditRecord", ...)`.

This script no longer performs any Rally queries itself. Pair it with `auditRecord/script.js` in a Repeating Group, or replace it entirely with Airtable's native "Find Records" action (recommended).

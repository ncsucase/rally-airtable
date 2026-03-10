# rally-airtable

Scripts for Airtable automations to sync data with Rally.

## compare.js

Paste `scripts/compare.js` into an Airtable Automation **Run a script** action inside a **Repeating Group**. The preceding script in the automation should fetch Rally records and pass them via `input.config()` as `rallyRecord`.

### Setup

Edit only the `CONFIG` object at the top of the script. Everything below it is the runtime and should not be modified.

```js
const CONFIG = {
  dryRun: false,         // set to true to log changes without writing anything

  diagnostics: {
    logConversions: false,  // set to true to console.log HTML↔Markdown input/output
  },

  rally: {
    baseUrl: "https://rally1.rallydev.com/slm/webservice/v2",
    apiKey: "YOUR_RALLY_API_KEY",
  },

  airtable: {
    tableId: "tblXXXXXXXXXXXXXX",  // ID of the table to sync into
  },

  recordMatch: {
    rallyField: "FormattedID",        // dot-path or extractor fn — uniquely identifies the Rally record
    airtableFieldId: "fldXXXXXXXXXXXX",  // field in Airtable holding the matching value
    ifNotFound: "create",             // "create" | "skip" | "error"
  },

  logging: {
    airtableLogFieldId: "fldXXXXXXXX", // field to write the sync log into; set to null to disable
    level: "changes",                   // "all" | "changes" | "errors"
  },

  fieldMappings: [ /* ... */ ],
};
```

### Supported Rally record types

compare.js is type-agnostic — it works with any Rally artifact type:

| Type | `_type` value |
|---|---|
| User Story | `HierarchicalRequirement` |
| Feature | `PortfolioItem/Feature` |
| Defect | `Defect` |
| Task | `Task` |
| Test Case | `TestCase` |

Two fields on the Rally record object drive this behavior:

- **`_type`** — used as the payload key when writing back to Rally (e.g. `{ "Defect": { ... } }`). Defaults to `"HierarchicalRequirement"` if absent.
- **`_ref`** — the Rally API URL used for write-back. Required for any mapping with `direction: "toRally"` or `"both"`. Not needed for `toAirtable`-only mappings.

Both fields are returned automatically by Rally's WSAPI — you do not need to add them to queryRally's `fetch` list.

### Field Mappings

Each entry in `fieldMappings` describes how one Rally field maps to one Airtable field.

| Property | Required | Description |
|---|---|---|
| `rallyField` | yes | Dot-path string (`"Owner.DisplayName"`) or extractor function `(r) => ...` |
| `airtableFieldId` | yes | Airtable field ID |
| `airtableFieldType` | yes | Airtable field type (see types below) |
| `direction` | yes | `"toAirtable"` \| `"toRally"` \| `"both"` |
| `sourceOfTruth` | no | Conflict resolution config (required when `direction: "both"`) |
| `transform` | no | `{ toAirtable: fn, toRally: fn }` — value transform functions |
| `matchMode` | no | `"exact"` (default) \| `"includes"` \| `"splitOwnership"` |
| `nullHandling` | no | Controls behavior when either side is null |
| `linkedRecord` | no | Required when `airtableFieldType: "linkedRecord"` |
| `rallyFieldKey` | no | Required when `rallyField` is a function and `direction` includes `"toRally"` |
| `rallyFieldType` | no | Type hint for Rally write coercion. Supported values: `"date"`, `"dateTime"`, `"tags"`, `"ref"`, `"boolean"`, `"number"`, `"html"` |
| `compareNormalize` | no | `(v) => normalizedV` — applied to both sides before comparison. Use when Rally and Airtable store the same data in different formats (e.g. HTML vs plain text). Applied after the built-in `richText` normalization. |

**Supported `airtableFieldType` values:** `singleLineText`, `multilineText`, `richText`, `email`, `url`, `phoneNumber`, `number`, `currency`, `percent`, `rating`, `duration`, `checkbox`, `date`, `dateTime`, `singleSelect`, `multipleSelect`, `linkedRecord`

#### linkedRecord config

Required when `airtableFieldType: "linkedRecord"`. Describes how to resolve and optionally create the linked record.

| Property | Required | Description |
|---|---|---|
| `linkedTableId` | yes | ID of the Airtable table containing the linked records |
| `lookup.fieldId` | yes | Field ID in the linked table to match against |
| `lookup.rallyValue` | yes | `(r) => value` — returns the lookup key from the Rally record |
| `createIfMissing` | no | If omitted, unmatched lookups return `null` and the field is cleared (or skipped if `nullHandling.rallyNull: "ignore"`). If provided, a new linked record is created with the specified fields when no match is found. |
| `createIfMissing.fields` | yes (if `createIfMissing` present) | Object mapping field IDs to value functions. Each function receives `(rallyRecord, details)` where `details` is the fetched Rally object (or `null` if `fetchRallyDetails` is not set or the fetch failed). Single-argument functions `(r) => ...` work unchanged. |
| `createIfMissing.fetchRallyDetails` | no | `(r) => _ref` — returns the Rally `_ref` URL of the nested object to fetch additional fields for (e.g. `(r) => r.Owner?._ref`). Called lazily — only when the linked record is not found in Airtable and a new one needs to be created. Results are cached by `_ref`, so the same nested object is only fetched once per sync run. |
| `createIfMissing.fetchRallyDetailFields` | no | Array of field names to fetch from the Rally object (e.g. `["DisplayName", "EmailAddress"]`). Omit to fetch all fields (`?fetch=true`). Only used when `fetchRallyDetails` is set. |

`richText` automatically converts Rally's HTML to Markdown when writing to Airtable. Pair it with `rallyFieldType: "html"` on the same mapping to convert Markdown back to HTML when writing to Rally.

> **Airtable field setup:** `richText` requires the Airtable field to be a **Long text** field with **"Enable rich text formatting"** turned on (found in the field's configuration panel). This is distinct from a plain Long text (`multilineText`) field — without rich text formatting enabled, Airtable will display the Markdown syntax as raw characters rather than rendering it.

#### sourceOfTruth modes

| Mode | Description |
|---|---|
| `preferRally` | Rally always wins |
| `preferAirtable` | Airtable always wins |
| `lastModified` | Most recently modified side wins. Requires `rallyTimestampField` and `airtableTimestampFieldId`. |
| `splitOwnership` | Each side owns specific values in a multi-select. Requires `rallyOwns` and `airtableOwns` arrays. |

#### nullHandling options

`rallyNull` controls what happens when the **Rally value is null**. `airtableNull` controls what happens when the **Airtable value is null**. These refer to which side's value is null, not which side is being written to.

For `direction: "toAirtable"`, `rallyNull` is the most important policy — Rally is the source, so a null Rally value directly determines what gets written to Airtable. `airtableNull` only affects the comparison used to detect whether values already match.

| Policy | Description |
|---|---|
| `"writeNull"` | Write null/empty to the target (default) |
| `"ignore"` | Skip this mapping entirely when the value is null |
| `"mapToValue"` | Substitute a literal value (set via `rallyNullValue` / `airtableNullValue`) |

---

### Handling multiple Rally record types

When compare.js processes records from more than one Rally artifact type (e.g. Features and User Stories fed by separate queryRally scripts), use extractor functions in `fieldMappings` to handle field differences between types gracefully.

#### Read from whichever field is present

```js
// Feature uses PlanEstimate; User Story may use a custom field
{
  rallyField: (r) => r.PlanEstimate ?? r.c_StoryPoints ?? null,
  airtableFieldId: "fldESTIMATEXXXXXX",
  airtableFieldType: "number",
  direction: "toAirtable",
  nullHandling: { rallyNull: "ignore", airtableNull: "writeNull" },
},
```

#### Branch on `_type`

```js
// Different state field names per type
{
  rallyField: (r) =>
    r._type === "PortfolioItem/Feature" ? r.State?.Name : r.ScheduleState,
  airtableFieldId: "fldSTATEXXXXXXXXX",
  airtableFieldType: "singleSelect",
  direction: "toAirtable",
  nullHandling: { rallyNull: "ignore", airtableNull: "writeNull" },
},
```

#### Normalize a label across types

```js
// Tag both Features and Stories with their artifact type
{
  rallyField: (r) =>
    r._type === "PortfolioItem/Feature" ? "Feature" : "User Story",
  airtableFieldId: "fldTYPEXXXXXXXXXX",
  airtableFieldType: "singleSelect",
  direction: "toAirtable",
  nullHandling: { rallyNull: "writeNull", airtableNull: "writeNull" },
},
```

Fields that exist on only one type will simply be `null` for records of the other type — `nullHandling: { rallyNull: "ignore" }` prevents those from overwriting existing Airtable values.

#### Walk a nested sub-object (e.g. Project.Parent)

Nested Rally objects (like `Project`) are trimmed to identity fields, but their own Rally sub-object references (like `Project.Parent`) are also preserved one level deep. This means you can inspect a parent project without a separate Rally API call:

```js
// Derive an ART name from the project or its parent
{
  rallyField: (r) => {
    const project = r.Project?._refObjectName ?? r.Project?.Name ?? "";
    const parent  = r.Project?.Parent?._refObjectName ?? r.Project?.Parent?.Name ?? "";
    const artName = /\bART\b/i.test(project) ? project
                  : /\bART\b/i.test(parent)  ? parent
                  : "";
    const name = artName.toLowerCase();
    if (name.includes("pay"))     return "Digital Payments";
    if (name.includes("account")) return "Account Servicing";
    if (name.includes("engage"))  return "PEFE";
    return null;
  },
  airtableFieldId: "fldXXXXXXXXXXXXXX",
  airtableFieldType: "singleSelect",
  direction: "toAirtable",
  nullHandling: { rallyNull: "writeNull", airtableNull: "ignore" },
},
```

`Project.Parent` is available automatically — no extra Rally API call or `fetchRallyDetails` needed. Only the identity fields (`ObjectID`, `Name`, `_refObjectName`, `_ref`, `_type`) are preserved on sub-objects; deeper nesting (e.g. `Project.Parent.Parent`) is not available.

---

### Field Mapping Examples

#### Example 1: Simple 1-to-1, Rally is always source of truth

```js
{
  rallyField: "Name",
  airtableFieldId: "fldAAAAAAAAAAAAAA",
  airtableFieldType: "singleLineText",
  direction: "both",
  sourceOfTruth: { mode: "preferRally" },
  nullHandling: {
    rallyNull: "ignore",
    airtableNull: "writeNull",
  },
},
```

#### Example 2: Status with value transform in both directions

```js
{
  rallyField: "ScheduleState",
  airtableFieldId: "fldBBBBBBBBBBBBBB",
  airtableFieldType: "singleSelect",
  direction: "both",
  sourceOfTruth: {
    mode: "lastModified",
    rallyTimestampField: "LastUpdateDate",
    airtableTimestampFieldId: "fldLASTMODIFIED",
  },
  transform: {
    toAirtable: (v) =>
      ({ "Defined": "Backlog", "In-Progress": "Active", "Completed": "Done" }[v] ?? v),
    toRally: (v) =>
      ({ "Backlog": "Defined", "Active": "In-Progress", "Done": "Completed" }[v] ?? v),
  },
  nullHandling: {
    rallyNull: "mapToValue",
    rallyNullValue: "Backlog",
    airtableNull: "writeNull",
  },
},
```

#### Example 3: Scrum team via extractor function, Airtable linked record

```js
{
  rallyField: (r) => {
    const knownTeams = ["Team Alpha", "Team Beta", "Team Gamma"];
    if (knownTeams.includes(r.Project?.Name)) return r.Project.Name;
    return r.Tags?._tagsNameArray?.find(t => knownTeams.includes(t.Name))?.Name ?? null;
  },
  airtableFieldId: "fldCCCCCCCCCCCCCC",
  airtableFieldType: "linkedRecord",
  direction: "toAirtable",
  matchMode: "exact",
  linkedRecord: {
    linkedTableId: "tblTEAMSXXXXXXXX",
    lookup: {
      fieldId: "fldTEAMNAMEXXXXXX",
      rallyValue: (r) => {
        const knownTeams = ["Team Alpha", "Team Beta", "Team Gamma"];
        if (knownTeams.includes(r.Project?.Name)) return r.Project.Name;
        return r.Tags?._tagsNameArray?.find(t => knownTeams.includes(t.Name))?.Name ?? null;
      },
    },
    createIfMissing: {
      fields: {
        "fldTEAMNAMEXXXXXX": (r) => r.Project?.Name,
      },
    },
  },
  nullHandling: {
    rallyNull: "ignore",
    airtableNull: "writeNull",
  },
},
```

#### Example 4: Multi-select tags with split ownership

```js
{
  rallyField: (r) => r.Tags?._tagsNameArray?.map(t => t.Name) ?? [],
  airtableFieldId: "fldDDDDDDDDDDDDDD",
  airtableFieldType: "multipleSelect",
  direction: "both",
  matchMode: "splitOwnership",
  sourceOfTruth: {
    mode: "splitOwnership",
    rallyOwns: ["Blocked", "In-Progress", "Needs Review"],
    airtableOwns: ["Client-Facing", "Carry-Over", "Flagged"],
  },
  nullHandling: {
    rallyNull: "ignore",
    airtableNull: "ignore",
  },
},
```

#### Example 5: Owner linked record with lazy Rally detail fetch

The main Rally query only returns a slim set of fields for nested objects like `Owner` (`DisplayName`, `EmailAddress`, `ObjectID`, etc.). If your `createIfMissing` needs fields that weren't included in the main query, use `fetchRallyDetails` to fetch the full Rally object — but only when a new linked record actually needs to be created.

```js
{
  rallyField: "Owner.DisplayName",
  airtableFieldId: "fldEEEEEEEEEEEEEE",
  airtableFieldType: "linkedRecord",
  direction: "toAirtable",
  matchMode: "exact",
  linkedRecord: {
    linkedTableId: "tblPEOPLEXXXXXXXX",
    lookup: {
      fieldId: "fldEMAILXXXXXXXXXX",
      rallyValue: (r) => r.Owner?.EmailAddress,
    },
    createIfMissing: {
      fetchRallyDetails: (r) => r.Owner?._ref,                        // fetch full Owner object from Rally
      fetchRallyDetailFields: ["DisplayName", "EmailAddress"],         // optional — omit to fetch all fields
      fields: {
        "fldNAMEXXXXXXXXXX":  (r, details) => details?.DisplayName  ?? r.Owner?.DisplayName,
        "fldEMAILXXXXXXXXXX": (r, details) => details?.EmailAddress ?? r.Owner?.EmailAddress,
      },
    },
  },
  nullHandling: {
    rallyNull: "ignore",
    airtableNull: "writeNull",
  },
},
```

`fetchRallyDetails` is only called when the Owner does not already exist in the linked Airtable table. If the Owner is found, no extra Rally API call is made. Results are cached by `_ref` — if multiple records share the same missing Owner, the Rally fetch happens only once.

#### Example 6: Rich text description with HTML↔Markdown conversion

Rally stores rich text fields (e.g. `Description` on Features) as HTML. Airtable's `richText` field type stores Markdown. Use `airtableFieldType: "richText"` to convert automatically in both directions.

```js
{
  rallyField: "Description",
  airtableFieldId: "fldDESCRIPTIONXXX",
  airtableFieldType: "richText",  // converts Rally HTML → Markdown on the way to Airtable
  rallyFieldKey: "Description",
  rallyFieldType: "html",         // converts Airtable Markdown → HTML on the way to Rally
  direction: "both",
  sourceOfTruth: { mode: "preferRally" },
  nullHandling: { rallyNull: "ignore", airtableNull: "writeNull" },
},
```

To inspect the conversion output without changing your `dryRun` setting, enable `diagnostics.logConversions` in CONFIG. The Airtable script console will print the input and converted output for every field processed with `richText` or `html` coercion.

#### Example 7: Plain text with URLs → HTML links in Rally, stable comparison

When an Airtable formula field produces plain text containing URLs, use `transform.toRally` to autolink them for Rally and `compareNormalize` to strip HTML from Rally's stored value so comparison stays in plain text on both sides.

```js
{
  rallyField: "SomeLinkField",
  airtableFieldId: "fldFORMULAXXXXXXX",
  airtableFieldType: "multilineText",
  rallyFieldKey: "SomeLinkField",
  direction: "toRally",
  transform: {
    toRally: (v) => v
      ? v.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>')
      : v,
  },
  compareNormalize: (v) => v ? v.replace(/<[^>]+>/g, "") : v,
  nullHandling: { rallyNull: "ignore", airtableNull: "writeNull" },
},
```

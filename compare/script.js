const CONFIG = {

  dryRun: false,

  diagnostics: {
    logConversions: false,  // set to true to console.log HTML↔Markdown input/output
    logComparisons: false,  // set to true to console.log compared values per field
  },

  rally: {
    baseUrl: "https://rally1.rallydev.com/slm/webservice/v2",
    apiKey: "YOUR_RALLY_API_KEY",
  },

  airtable: {
    tableId: "tblXXXXXXXXXXXXXX",
    baseId:  "appXXXXXXXXXXXXXX",  // required for attachment uploads (from your Airtable base URL)
    apiKey:  "patXXXXXXXXXXXXXX",  // PAT with data.records:write + attachments:write scopes
  },

  // How to match a Rally record to an Airtable record
  recordMatch: {
    rallyField: "FormattedID",          // dot-path or extractor fn
    airtableFieldId: "fldXXXXXXXXXXXX",
    ifNotFound: "create",               // "create" | "skip" | "error"
  },

  logging: {
    airtableLogFieldId: "fldXXXXXXXXXX", // set to null to disable write-back
    level: "changes",                     // "all" | "changes" | "errors"
  },

  fieldMappings: [

    {
      rallyField: "Name",
      airtableFieldId: "fldAAAAAAAAAAAAAA",
      airtableFieldType: "singleLineText",
      direction: "both",
      sourceOfTruth: { mode: "preferRally" },
      nullHandling: {
        rallyNull: "ignore",          // don't clear Airtable if Rally is null
        airtableNull: "writeNull",
      },
    },

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
          fieldId: "fldTEAMNAMEXXXXXX",       // field in linked table to match on
          rallyValue: (r) => {                  // how to get match value from Rally record
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
          fields: {
            "fldNAMEXXXXXXXXXX":  (r) => r.Owner?.DisplayName,
            "fldEMAILXXXXXXXXXX": (r) => r.Owner?.EmailAddress,
          },
        },
      },
      nullHandling: {
        rallyNull: "ignore",
        airtableNull: "writeNull",
      },
    },

  ], // end fieldMappings
}; // end CONFIG

// --- Utilities ----------------------------------------------------------------

function getRallyValue(rallyRecord, rallyField) {
  if (typeof rallyField === "function") {
    return rallyField(rallyRecord);
  }
  // Dot-path traversal e.g. "Owner.DisplayName"
  return rallyField.split(".").reduce((obj, key) => obj?.[key] ?? null, rallyRecord);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((v, i) => v === sortedB[i]);
  }
  return false;
}

function includes(superset, subset) {
  if (!Array.isArray(superset) || !Array.isArray(subset)) return false;
  return subset.every(v => superset.includes(v));
}

// --- HTML ↔ Markdown Conversion -----------------------------------------------

function convertTableToMarkdown(tableHtml) {
  let s = tableHtml;
  // Remove colgroup/col blocks — they are column width metadata, not content
  s = s.replace(/<colgroup[^>]*>[\s\S]*?<\/colgroup>/gi, "");
  // Unwrap thead/tbody/tfoot — keep their row content
  s = s.replace(/<\/?(thead|tbody|tfoot)[^>]*>/gi, "");

  const rowMatches = [...s.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const rows = [];
  for (const [, rowInner] of rowMatches) {
    const cells = [];
    for (const [, cellInner] of rowInner.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)) {
      const content = decodeHtmlEntities(cellInner.replace(/<[^>]+>/g, "")).trim();
      cells.push(content);
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return "";

  const colCount = Math.max(...rows.map(r => r.length));
  const separator = "|" + Array(colCount).fill("---|").join("");
  const mdRows = rows.map(cells => {
    while (cells.length < colCount) cells.push("");
    return "| " + cells.join(" | ") + " |";
  });
  mdRows.splice(1, 0, separator);  // separator after header row
  return "\n\n" + mdRows.join("\n") + "\n\n";
}

function htmlToMarkdown(html) {
  if (!html) return "";
  let s = html;

  // Strip <style> and <script> blocks entirely
  s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");

  // Code blocks — process before inline tags so inner content is protected
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    const code = inner.replace(/<code[^>]*>/gi, "").replace(/<\/code>/gi, "");
    return "\n```\n" + decodeHtmlEntities(code.trim()) + "\n```\n";
  });

  // Links
  s = s.replace(/<a[^>]+href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // Bold
  s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**");
  s = s.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**");

  // Italic
  s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*");
  s = s.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "*$1*");

  // Inline code (pre already handled above)
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Headings
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  s = s.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  s = s.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  s = s.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

  // Ordered lists — track counter per list
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
    let n = 0;
    return inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (__, item) => `\n${++n}. ${item}`) + "\n";
  });

  // Unordered lists
  s = s.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner) =>
    inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1") + "\n"
  );

  // Tables — convert to Markdown pipe tables before stripping remaining tags
  s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, inner) => convertTableToMarkdown(inner));
  // Strip <figure> wrappers (table already converted above; other figures just unwrap)
  s = s.replace(/<\/?figure[^>]*>/gi, "");

  // Remaining block-level element closes → newlines
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<\/div>/gi, "\n");
  s = s.replace(/<\/blockquote>/gi, "\n");

  // Convert <img> tags to named placeholders before stripping so position is preserved
  s = s.replace(/<img[^>]+>/gi, imgTag => {
    const alt = (imgTag.match(/alt=["']([^"']*?)["']/i) ?? [])[1];
    const src = (imgTag.match(/src=["']([^"']+)["']/i) ?? [])[1] ?? "";
    const name = alt?.trim() || src.split("/").pop().split("?")[0] || "image";
    return `[Image: ${name}]`;
  });

  // Strip all remaining HTML tags
  s = s.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  s = decodeHtmlEntities(s);

  // Normalize: collapse 3+ newlines to 2, trim
  s = s.replace(/\n{3,}/g, "\n\n").trim();

  if (CONFIG.diagnostics?.logConversions) {
    console.log("[htmlToMarkdown] INPUT:", html);
    console.log("[htmlToMarkdown] OUTPUT:", s);
  }
  return s;
}

function extractImagesFromHtml(html) {
  if (!html) return [];
  const seen = new Set();
  const images = [];
  const imgTags = html.match(/<img[^>]+>/gi) ?? [];
  for (let i = 0; i < imgTags.length; i++) {
    const tag = imgTags[i];
    const srcMatch = tag.match(/src=["']([^"']+)["']/i);
    if (!srcMatch) continue;
    let src = srcMatch[1];
    if (src.startsWith("//")) src = "https:" + src;
    else if (src.startsWith("/")) src = "https://rally1.rallydev.com" + src;
    if (seen.has(src)) continue;
    seen.add(src);
    const altMatch = tag.match(/alt=["']([^"']*?)["']/i);
    const alt = altMatch?.[1]?.trim();
    const urlName = src.split("/").pop().split("?")[0];
    const ext = urlName.match(/\.[a-zA-Z0-9]{2,5}$/)?.[0] ?? ".png";
    let filename;
    if (alt) {
      filename = alt.replace(/[^a-zA-Z0-9._-]/g, "_") + (alt.includes(".") ? "" : ext);
    } else {
      filename = urlName || `image_${i}${ext}`;
    }
    images.push({ src, filename });
  }
  return images;
}

async function fetchImageAsArrayBuffer(url) {
  try {
    const response = await fetch(url, { headers: { "ZSESSIONID": CONFIG.rally.apiKey } });
    if (!response.ok) {
      log(`Failed to fetch image ${url}: HTTP ${response.status}`, "error");
      return null;
    }
    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    return { buffer, contentType };
  } catch (err) {
    log(`Error fetching image ${url}: ${err.message}`, "error");
    return null;
  }
}

async function uploadAttachmentToAirtable(recordId, fieldId, buffer, filename, contentType) {
  try {
    const url = `https://content.airtable.com/v0/${CONFIG.airtable.baseId}/${recordId}/${fieldId}/uploadAttachment`;
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: contentType }), filename);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${CONFIG.airtable.apiKey}` },
      body: form,
    });
    if (!response.ok) {
      const text = await response.text();
      log(`Failed to upload attachment ${filename}: HTTP ${response.status} — ${text}`, "error");
      return false;
    }
    return true;
  } catch (err) {
    log(`Error uploading attachment ${filename}: ${err.message}`, "error");
    return false;
  }
}

function markdownToHtml(md) {
  if (!md) return "";
  let s = md;

  // Fenced code blocks — process first to protect content
  s = s.replace(/```([\s\S]*?)```/g, (_, code) =>
    `<pre><code>${escapeHtml(code.trim())}</code></pre>`
  );

  // Process line by line for block-level elements
  const lines = s.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Already-converted block (from code block pass above) — pass through
    if (/^<(pre|ul|ol|h[1-6])/i.test(line.trim())) {
      out.push(line);
      i++;
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level}>${applyInlineMarkdown(hMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Unordered list — collect consecutive bullet lines
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${applyInlineMarkdown(lines[i].replace(/^[-*]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list — collect consecutive numbered lines
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${applyInlineMarkdown(lines[i].replace(/^\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    out.push(line);
    i++;
  }

  // Wrap non-block content in <p> tags; separate on blank lines
  let html = "";
  const paragraphs = out.join("\n").split(/\n{2,}/);
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (/^<(h[1-6]|ul|ol|pre|blockquote)/i.test(trimmed)) {
      html += trimmed + "\n";
    } else {
      html += "<p>" + applyInlineMarkdown(trimmed).replace(/\n/g, "<br>") + "</p>\n";
    }
  }

  html = html.trim();

  if (CONFIG.diagnostics?.logConversions) {
    console.log("[markdownToHtml] INPUT:", md);
    console.log("[markdownToHtml] OUTPUT:", html);
  }
  return html;
}

function applyInlineMarkdown(text) {
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  return text;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- Null Handling ------------------------------------------------------------

function applyNullHandling(value, nullPolicy, nullValue) {
  if (value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0)) {
    return value;
  }
  switch (nullPolicy) {
    case "mapToValue": return nullValue ?? null;
    case "ignore":     return undefined; // sentinel: skip this mapping
    case "writeNull":
    default:           return null;
  }
}

// --- Airtable Coercion -------------------------------------------------------

function coerceForAirtable(value, fieldType, resolvedIds) {
  if (value === null || value === undefined) return null;

  switch (fieldType) {
    case "singleLineText":
    case "multilineText":
    case "email":
    case "url":
    case "phoneNumber":
      return String(value);

    case "number":
    case "currency":
    case "percent":
    case "rating":
    case "duration":
      return Number(value);

    case "checkbox":
      return Boolean(value);

    case "date":
      return toIso8601Date(value);

    case "dateTime":
      return toIso8601DateTime(value);

    case "singleSelect":
      return String(value);

    case "multipleSelect":
      return Array.isArray(value) ? value.map(String) : [String(value)];

    case "richText":
      return htmlToMarkdown(String(value));

    case "linkedRecord":
      // resolvedIds is an array of { id } objects as Airtable expects
      return resolvedIds ?? [];

    default:
      return value;
  }
}

function toIso8601Date(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function toIso8601DateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d) ? null : d.toISOString();
}

// --- Rally Coercion ----------------------------------------------------------

function coerceForRally(value, rallyFieldHint) {
  if (value === null || value === undefined) return null;

  switch (rallyFieldHint) {
    case "date":
    case "dateTime":
      return toIso8601DateTime(value);

    case "tags":
      // Rally expects { _tagsNameArray: [{ Name: "..." }] }
      const tags = Array.isArray(value) ? value : [value];
      return { _tagsNameArray: tags.map(t => ({ Name: String(t) })) };

    case "ref":
      // Caller must supply the _ref URL string; we just wrap it
      return { _ref: String(value) };

    case "boolean":
      return Boolean(value);

    case "number":
      return Number(value);

    case "html":
      return markdownToHtml(String(value));

    default:
      return value;
  }
}

// --- Airtable cell value extraction ------------------------------------------

function extractAirtableValue(airtableRecord, mapping) {
  const raw = airtableRecord.getCellValue(mapping.airtableFieldId);
  const type = mapping.airtableFieldType;

  if (raw === null || raw === undefined) return null;

  switch (type) {
    case "linkedRecord":
      return Array.isArray(raw) ? raw.map(r => r.name ?? r.id) : [];

    case "multipleSelect":
      return Array.isArray(raw) ? raw.map(o => o.name ?? o) : [];

    case "singleSelect":
      return raw?.name ?? raw ?? null;

    case "date":
    case "dateTime":
      return raw ? new Date(raw).toISOString() : null;

    default:
      return raw;
  }
}

// --- Conflict resolution -----------------------------------------------------

async function resolveConflict(rallyVal, airtableVal, mapping, rallyRecord, airtableRecord) {
  const sot = mapping.sourceOfTruth;
  if (!sot) return { winner: "rally", value: rallyVal };

  switch (sot.mode) {

    case "preferRally":
      return { winner: "rally", value: rallyVal };

    case "preferAirtable":
      return { winner: "airtable", value: airtableVal };

    case "lastModified": {
      const rallyTs = getRallyValue(rallyRecord, sot.rallyTimestampField);
      const airtableTs = airtableRecord.getCellValue(sot.airtableTimestampFieldId);
      const rDate = rallyTs ? new Date(rallyTs) : new Date(0);
      const aDate = airtableTs ? new Date(airtableTs) : new Date(0);
      if (rDate >= aDate) return { winner: "rally", value: rallyVal };
      return { winner: "airtable", value: airtableVal };
    }

    case "splitOwnership": {
      // Merge: each side controls its own values; unrecognized values are untouched
      const rallyOwns    = sot.rallyOwns    ?? [];
      const airtableOwns = sot.airtableOwns ?? [];
      const currentAirtable = Array.isArray(airtableVal) ? airtableVal : [];
      const currentRally    = Array.isArray(rallyVal)    ? rallyVal    : [];

      // Start from current Airtable state, then apply each side's owned values
      const unowned = currentAirtable.filter(
        v => !rallyOwns.includes(v) && !airtableOwns.includes(v)
      );
      const airtablePart = airtableOwns.filter(v => currentAirtable.includes(v));
      const rallyPart    = rallyOwns.filter(v => currentRally.includes(v));
      const merged = [...new Set([...unowned, ...airtablePart, ...rallyPart])];
      return { winner: "split", value: merged };
    }

    default:
      return { winner: "rally", value: rallyVal };
  }
}

// --- Linked record resolution with cache -------------------------------------

// Cache: linkedRecordCache[tableId][fieldId][lookupValue] = airtableRecordId
const linkedRecordCache = {};

// Cache: rallyDetailsCache[ref] = fetched Rally object details (or null on error)
const rallyDetailsCache = {};

async function fetchRallyDetails(ref, fields = []) {
  if (!ref) return null;
  if (rallyDetailsCache[ref] !== undefined) return rallyDetailsCache[ref];

  try {
    const fetchParam = fields.length > 0 ? fields.join(",") : "true";
    const response = await fetch(`${ref}?fetch=${fetchParam}`, {
      headers: { "ZSESSIONID": CONFIG.rally.apiKey },
    });
    if (!response.ok) {
      log(`[fetchRallyDetails] Rally fetch failed for ${ref}: ${response.status}`, "error");
      return (rallyDetailsCache[ref] = null);
    }
    const json = await response.json();
    // Rally single-object endpoint returns { [TypeName]: { ...fields } }
    const details = Object.values(json).find(v => v && typeof v === "object" && !Array.isArray(v)) ?? null;
    return (rallyDetailsCache[ref] = details);
  } catch (err) {
    log(`[fetchRallyDetails] Error for ${ref}: ${err.message}`, "error");
    return (rallyDetailsCache[ref] = null);
  }
}

async function resolveLinkedRecordId(linkedTableId, lookupFieldId, lookupValue, createConfig, rallyRecord, normalize = v => v) {
  if (lookupValue === null || lookupValue === undefined) return null;

  const key = String(normalize(lookupValue));

  // Check cache
  linkedRecordCache[linkedTableId] ??= {};
  linkedRecordCache[linkedTableId][lookupFieldId] ??= {};
  if (linkedRecordCache[linkedTableId][lookupFieldId][key] !== undefined) {
    return linkedRecordCache[linkedTableId][lookupFieldId][key];
  }

  // Query Airtable for existing record
  const linkedTable = base.getTable(linkedTableId);
  const results = await linkedTable.selectRecordsAsync({
    fields: [lookupFieldId],
  });

  for (const record of results.records) {
    const val = normalize(record.getCellValueAsString(lookupFieldId));
    linkedRecordCache[linkedTableId][lookupFieldId][val] = record.id;
  }

  if (linkedRecordCache[linkedTableId][lookupFieldId][key] !== undefined) {
    return linkedRecordCache[linkedTableId][lookupFieldId][key];
  }

  // Not found — create if configured
  if (createConfig && !CONFIG.dryRun) {
    let details = null;
    if (createConfig.fetchRallyDetails) {
      const ref = createConfig.fetchRallyDetails(rallyRecord);
      if (ref) details = await fetchRallyDetails(ref, createConfig.fetchRallyDetailFields ?? []);
    }
    const fieldsToWrite = {};
    for (const [fieldId, valueFn] of Object.entries(createConfig.fields)) {
      const val = typeof valueFn === "function" ? valueFn(rallyRecord, details) : valueFn;
      if (val !== null && val !== undefined) fieldsToWrite[fieldId] = val;
    }
    const newId = await linkedTable.createRecordAsync(fieldsToWrite);
    linkedRecordCache[linkedTableId][lookupFieldId][key] = newId;
    return newId;
  }

  if (createConfig && CONFIG.dryRun) {
    log(`[DRY RUN] Would create linked record in ${linkedTableId} for lookup: ${key}`);
    linkedRecordCache[linkedTableId][lookupFieldId][key] = `[dry-run-id:${key}]`;
    return linkedRecordCache[linkedTableId][lookupFieldId][key];
  }

  linkedRecordCache[linkedTableId][lookupFieldId][key] = null;
  return null;
}

// --- Logging -----------------------------------------------------------------

const logEntries = [];

function log(message, level = "info") {
  console.log(message);
  logEntries.push({ ts: new Date().toISOString(), level, message });
}

function logMapping(entry) {
  logEntries.push({ ts: new Date().toISOString(), level: "mapping", ...entry });
}

function buildLogText(rallyId, airtableRecordId) {
  const header = `Sync @ ${new Date().toISOString()} | Rally: ${rallyId} | Airtable: ${airtableRecordId} | DryRun: ${CONFIG.dryRun}`;
  const lines = logEntries
    .filter(e => {
      if (CONFIG.logging.level === "errors")  return e.level === "error";
      if (CONFIG.logging.level === "changes") return ["mapping", "error"].includes(e.level) && e.action !== "noChange";
      return true;
    })
    .map(e => {
      if (e.level === "mapping") {
        return `  [${e.action}] ${e.airtableFieldId} | ${e.direction} | was: ${JSON.stringify(e.previous)} → now: ${JSON.stringify(e.next)} | resolved by: ${e.resolvedBy}`;
      }
      return `  [${e.level}] ${e.message}`;
    });
  return [header, ...lines].join("\n");
}

// --- Rally API ---------------------------------------------------------------

async function updateRallyRecord(rallyRecord, fields) {
  const type = rallyRecord._type ?? "HierarchicalRequirement";
  const ref  = rallyRecord._ref;
  if (!ref) throw new Error("Rally record missing _ref — cannot update");

  const body = { [type]: fields };
  const response = await fetch(ref, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ZSESSIONID": CONFIG.rally.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Rally update failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

// --- Attachment sync ---------------------------------------------------------

async function syncAttachmentField(rallyRecord, airtableRecord, mapping) {
  const html = getRallyValue(rallyRecord, mapping.rallySourceField);
  if (!html) return;

  const images = extractImagesFromHtml(html);
  if (images.length === 0) return;

  const existing = airtableRecord.getCellValue(mapping.airtableFieldId) ?? [];
  const existingFilenames = new Set(existing.map(a => a.filename));

  for (const { src, filename } of images) {
    if (existingFilenames.has(filename)) {
      log(`Attachment already present, skipping: ${filename}`);
      continue;
    }
    const result = await fetchImageAsArrayBuffer(src);
    if (!result) continue;
    if (CONFIG.dryRun) {
      log(`[DRY RUN] Would upload attachment: ${filename} to field ${mapping.airtableFieldId}`);
      continue;
    }
    const ok = await uploadAttachmentToAirtable(
      airtableRecord.id, mapping.airtableFieldId,
      result.buffer, filename, result.contentType
    );
    if (ok) {
      log(`Uploaded attachment: ${filename}`);
      existingFilenames.add(filename);
    }
  }
}

// --- Main sync logic ---------------------------------------------------------

async function syncRecord(rallyRecord, airtableRecord, isNewRecord) {
  const airtableUpdates = {};
  const rallyUpdates    = {};

  // ---- Pre-pass: resolve all linked records first -------------------------
  for (const mapping of CONFIG.fieldMappings) {
    if (mapping.airtableFieldType !== "linkedRecord") continue;
    if (!mapping.linkedRecord) continue;

    const { linkedRecord } = mapping;
    const lookupValue = linkedRecord.lookup.rallyValue
      ? getRallyValue(rallyRecord, linkedRecord.lookup.rallyValue)
      : getRallyValue(rallyRecord, mapping.rallyField);

    await resolveLinkedRecordId(
      linkedRecord.linkedTableId,
      linkedRecord.lookup.fieldId,
      lookupValue,
      linkedRecord.createIfMissing ?? null,
      rallyRecord,
      linkedRecord.lookup.normalize
    );
  }

  // ---- Per-mapping comparison and changeset building ----------------------
  for (const mapping of CONFIG.fieldMappings) {
    if (mapping.airtableFieldType === "attachment") continue;
    try {
      // 1. Extract raw values
      let rawRally    = getRallyValue(rallyRecord, mapping.rallyField);
      let rawAirtable = isNewRecord ? null : extractAirtableValue(airtableRecord, mapping);

      // 2. Apply transforms
      const toAirtableFn = mapping.transform?.toAirtable;
      const toRallyFn    = mapping.transform?.toRally;
      let transformedRally    = toAirtableFn ? toAirtableFn(rawRally)    : rawRally;
      let transformedAirtable = toRallyFn    ? toRallyFn(rawAirtable)    : rawAirtable;

      // 3. Apply null handling
      const rallyNullPolicy    = mapping.nullHandling?.rallyNull    ?? "writeNull";
      const airtableNullPolicy = mapping.nullHandling?.airtableNull ?? "writeNull";
      const rallyNullValue     = mapping.nullHandling?.rallyNullValue;
      const airtableNullValue  = mapping.nullHandling?.airtableNullValue;

      const handledRally    = applyNullHandling(transformedRally,    rallyNullPolicy,    rallyNullValue);
      const handledAirtable = applyNullHandling(transformedAirtable, airtableNullPolicy, airtableNullValue);

      // undefined = "ignore" sentinel from nullHandling
      if (handledRally === undefined && handledAirtable === undefined) {
        logMapping({ airtableFieldId: mapping.airtableFieldId, action: "noChange", direction: "n/a", previous: rawRally, next: rawRally, resolvedBy: "nullHandling:ignore" });
        continue;
      }

      const normalizedRally    = handledRally    !== undefined ? handledRally    : null;
      const normalizedAirtable = handledAirtable !== undefined ? handledAirtable : null;

      // 4. Determine match
      // For richText fields, Rally stores HTML and Airtable stores Markdown — normalize
      // both to Markdown for comparison so differing formats don't trigger false writes.
      let compareRally    = normalizedRally;
      let compareAirtable = normalizedAirtable;
      if (mapping.airtableFieldType === "richText") {
        // htmlToMarkdown already trims; trim Airtable side to match
        if (compareRally    !== null) compareRally    = htmlToMarkdown(String(compareRally));
        if (compareAirtable !== null) compareAirtable = String(compareAirtable).trim();
      }

      if (mapping.airtableFieldType === "date") {
        // Rally and Airtable may store the same calendar date at different UTC times
        // due to timezone offsets (e.g. midnight EDT = 04:00Z). Compare YYYY-MM-DD only.
        if (compareRally    !== null) compareRally    = String(compareRally).slice(0, 10);
        if (compareAirtable !== null) compareAirtable = String(compareAirtable).slice(0, 10);
      }

      if (mapping.airtableFieldType === "linkedRecord") {
        // rallyField returns a string; Airtable linked record values are arrays.
        // Wrap the Rally side so deepEqual compares array-to-array.
        if (compareRally !== null && !Array.isArray(compareRally)) {
          compareRally = [compareRally];
        }
      }

      // Custom comparison normalization — applied to both sides after richText normalization.
      // Use this when Rally and Airtable store the same data in different formats.
      if (mapping.compareNormalize) {
        compareRally    = compareRally    !== null ? mapping.compareNormalize(compareRally)    : null;
        compareAirtable = compareAirtable !== null ? mapping.compareNormalize(compareAirtable) : null;
      }

      const matchMode = mapping.matchMode ?? "exact";
      let alreadyMatch = false;

      if (matchMode === "exact") {
        alreadyMatch = deepEqual(compareRally, compareAirtable);
      } else if (matchMode === "includes") {
        const rArr = Array.isArray(compareRally) ? compareRally : [compareRally];
        alreadyMatch = includes(Array.isArray(compareAirtable) ? compareAirtable : [], rArr);
      } else if (matchMode === "splitOwnership") {
        // Will compute merged value below; never "already matching" unless resolved
        alreadyMatch = false;
      }

      if (CONFIG.diagnostics?.logComparisons) {
        console.log(
          `[compare] ${mapping.airtableFieldId}`,
          "\n  rally:    ", compareRally,
          "\n  airtable:", compareAirtable,
          "\n  match:    ", alreadyMatch,
        );
      }

      if (alreadyMatch && mapping.direction !== "both") {
        logMapping({ airtableFieldId: mapping.airtableFieldId, action: "noChange", direction: "noChange", previous: normalizedAirtable, next: normalizedAirtable, resolvedBy: "alreadyMatch" });
        continue;
      }

      // 5. Conflict resolution for "both" direction
      let winnerValue, winnerSide, resolvedBy;

      if (mapping.direction === "toAirtable") {
        winnerValue = normalizedRally;
        winnerSide  = "airtable";
        resolvedBy  = "direction:toAirtable";
      } else if (mapping.direction === "toRally") {
        winnerValue = normalizedAirtable;
        winnerSide  = "rally";
        resolvedBy  = "direction:toRally";
      } else {
        // "both" — resolve conflict
        const resolution = await resolveConflict(normalizedRally, normalizedAirtable, mapping, rallyRecord, airtableRecord);
        winnerValue = resolution.value;
        winnerSide  = resolution.winner === "airtable" ? "rally" : "airtable"; // winner side = where to write
        resolvedBy  = `sourceOfTruth:${mapping.sourceOfTruth?.mode}`;

        if (alreadyMatch && matchMode !== "splitOwnership") {
          logMapping({ airtableFieldId: mapping.airtableFieldId, action: "noChange", direction: "noChange", previous: normalizedAirtable, next: normalizedAirtable, resolvedBy });
          continue;
        }
      }

      // 6. Build changesets
      if (mapping.direction === "toAirtable" || (mapping.direction === "both" && winnerSide === "airtable")) {
        // Resolve linked record IDs if needed
        let coercedValue;
        if (mapping.airtableFieldType === "linkedRecord" && mapping.linkedRecord) {
          const lookupValue = mapping.linkedRecord.lookup.rallyValue
            ? getRallyValue(rallyRecord, mapping.linkedRecord.lookup.rallyValue)
            : winnerValue;
          const lookupNormalize = mapping.linkedRecord.lookup.normalize ?? (v => v);
          const resolvedId = linkedRecordCache[mapping.linkedRecord.linkedTableId]
            ?.[mapping.linkedRecord.lookup.fieldId]
            ?.[String(lookupNormalize(lookupValue))];
          coercedValue = coerceForAirtable(winnerValue, mapping.airtableFieldType, resolvedId ? [{ id: resolvedId }] : []);
        } else {
          coercedValue = coerceForAirtable(winnerValue, mapping.airtableFieldType, null);
        }

        airtableUpdates[mapping.airtableFieldId] = coercedValue;
        logMapping({
          airtableFieldId: mapping.airtableFieldId,
          action: "updateAirtable",
          direction: "toAirtable",
          previous: normalizedAirtable,
          next: coercedValue,
          resolvedBy,
        });
      }

      if (mapping.direction === "toRally" || (mapping.direction === "both" && winnerSide === "rally")) {
        const rallyFieldHint = mapping.rallyFieldType ?? "default";
        const coercedValue   = coerceForRally(winnerValue, rallyFieldHint);
        const rallyKey       = typeof mapping.rallyField === "string" ? mapping.rallyField : mapping.rallyFieldKey;
        if (rallyKey) {
          rallyUpdates[rallyKey] = coercedValue;
          logMapping({
            airtableFieldId: mapping.airtableFieldId,
            action: "updateRally",
            direction: "toRally",
            previous: normalizedRally,
            next: coercedValue,
            resolvedBy,
          });
        } else {
          log(`Cannot write to Rally: mapping for ${mapping.airtableFieldId} uses extractor fn but no rallyFieldKey is defined`, "error");
        }
      }

    } catch (err) {
      log(`Error processing mapping for field ${mapping.airtableFieldId}: ${err.message}`, "error");
    }
  }

  return { airtableUpdates, rallyUpdates };
}

// --- Airtable record lookup / create -----------------------------------------

async function findOrCreateAirtableRecord(rallyRecord) {
  const { rallyField, airtableFieldId, ifNotFound } = CONFIG.recordMatch;
  const matchValue = String(getRallyValue(rallyRecord, rallyField));

  const table   = base.getTable(CONFIG.airtable.tableId);
  const mappedFieldIds = CONFIG.fieldMappings.map(m => m.airtableFieldId);
  const results = await table.selectRecordsAsync({ fields: [airtableFieldId, ...mappedFieldIds] });

  const found = results.records.find(
    r => r.getCellValueAsString(airtableFieldId) === matchValue
  );
  if (found) return { record: found, isNew: false };

  if (ifNotFound === "skip") {
    log(`No Airtable record found for Rally ${matchValue} — skipping`);
    return { record: null, isNew: false };
  }
  if (ifNotFound === "error") {
    throw new Error(`No Airtable record found for Rally ${matchValue}`);
  }

  // create
  if (CONFIG.dryRun) {
    log(`[DRY RUN] Would create Airtable record for Rally ${matchValue}`);
    return { record: null, isNew: true };
  }

  const newId = await table.createRecordAsync({ [airtableFieldId]: matchValue });
  const newResults = await table.selectRecordsAsync({ fields: [airtableFieldId] });
  const newRecord  = newResults.records.find(r => r.id === newId);
  return { record: newRecord, isNew: true };
}

// --- Entry point -------------------------------------------------------------

async function main() {
  // Receive the Rally record from the repeating group input
  const inputCfg   = input.config();
  const rallyRecord = JSON.parse(inputCfg.rallyRecord);

  if (!rallyRecord) throw new Error("No rallyRecord provided in input.config()");

  const rallyId = getRallyValue(rallyRecord, CONFIG.recordMatch.rallyField) ?? "unknown";
  log(`Starting sync for Rally record: ${rallyId}`);

  // Find or create the matching Airtable record
  const { record: airtableRecord, isNew } = await findOrCreateAirtableRecord(rallyRecord);
  if (!airtableRecord && !isNew) {
    // skip case
    return;
  }

  const airtableRecordId = airtableRecord?.id ?? "[new]";
  log(`Matched Airtable record: ${airtableRecordId} | isNew: ${isNew}`);

  // Run the sync
  const { airtableUpdates, rallyUpdates } = await syncRecord(rallyRecord, airtableRecord, isNew);

  // Apply Airtable updates
  if (Object.keys(airtableUpdates).length > 0) {
    if (CONFIG.dryRun) {
      log(`[DRY RUN] Would update Airtable record ${airtableRecordId} with: ${JSON.stringify(airtableUpdates, null, 2)}`);
    } else {
      const table = base.getTable(CONFIG.airtable.tableId);
      await table.updateRecordAsync(airtableRecordId, airtableUpdates);
      log(`Updated Airtable record ${airtableRecordId}`);
    }
  } else {
    log("No Airtable updates required");
  }

  // Attachment sync pass — runs after standard updates so the record always exists
  if (airtableRecord) {
    for (const mapping of CONFIG.fieldMappings) {
      if (mapping.airtableFieldType !== "attachment") continue;
      try {
        await syncAttachmentField(rallyRecord, airtableRecord, mapping);
      } catch (err) {
        log(`Error syncing attachment field ${mapping.airtableFieldId}: ${err.message}`, "error");
      }
    }
  }

  // Apply Rally updates
  if (Object.keys(rallyUpdates).length > 0) {
    if (CONFIG.dryRun) {
      log(`[DRY RUN] Would update Rally record ${rallyId} with: ${JSON.stringify(rallyUpdates, null, 2)}`);
    } else {
      await updateRallyRecord(rallyRecord, rallyUpdates);
      log(`Updated Rally record ${rallyId}`);
    }
  } else {
    log("No Rally updates required");
  }

  // Write log back to Airtable
  if (CONFIG.logging.airtableLogFieldId && airtableRecord && !isNew) {
    const logText = buildLogText(rallyId, airtableRecordId);
    if (!CONFIG.dryRun) {
      const table = base.getTable(CONFIG.airtable.tableId);
      await table.updateRecordAsync(airtableRecordId, {
        [CONFIG.logging.airtableLogFieldId]: logText,
      });
    } else {
      log(`[DRY RUN] Would write log to field ${CONFIG.logging.airtableLogFieldId}`);
    }
  }

  log(`Sync complete for Rally record: ${rallyId}`);
}

await main();

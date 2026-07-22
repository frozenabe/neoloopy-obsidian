/**
 * Export renderers — TypeScript port of the qualitative subset of
 * `core/lib/cli/formats.dart` (`buildMermaid`, `loopNoteKey`, and `render` for
 * json | markdown | mermaid). SVG and Cypher are intentionally out of v1 scope.
 * Operates on plain node/edge/loop records so it stays storage-agnostic.
 */

export interface ExportNode {
  id: string;
  name: string;
  kind?: string;
  x?: number;
  y?: number;
  group?: string;
}

export interface ExportEdge {
  id?: string;
  source: string;
  target: string;
  polarity?: number | "?";
  delay?: boolean;
  curvature?: number;
  dashed?: boolean;
  weight?: number;
}

export interface ExportLoop {
  loop: string[];
  type: string;
  label?: string;
}

export interface Rendered {
  content: string;
  mime: string;
  ext: string;
}

export interface RenderOpts {
  notes?: Record<string, string>;
  valence?: Record<string, string>;
  titles?: Record<string, string>;
  hypothesis?: Record<string, unknown>;
}

/** Stable identity for a loop's note: `<R|B>:<sorted unique variable names>`. */
export function loopNoteKey(loop: string[], typeStr: string): string {
  const core =
    loop.length > 1 && loop.length > 0 && loop[0] === loop[loop.length - 1]
      ? loop.slice(0, loop.length - 1)
      : loop;
  const letter = typeStr.toUpperCase().startsWith("R") ? "R" : "B";
  const uniq = [...new Set(core.map(String))].sort();
  return `${letter}:${uniq.join("|")}`;
}

export function buildMermaid(nodes: ExportNode[], edges: ExportEdge[]): string {
  const key = new Map<string, string>();
  nodes.forEach((n, i) => key.set(String(n.id), `v${i}`));
  const lines = ["graph LR"];
  for (const n of nodes) {
    const label = n.name.replace(/"/g, "'");
    lines.push(`  ${key.get(String(n.id))}["${label}"]`);
  }
  for (const e of edges) {
    const s = key.get(String(e.source));
    const t = key.get(String(e.target));
    if (!s || !t) continue;
    const sym = e.polarity === "?" ? "?" : (e.polarity ?? 1) >= 0 ? "+" : "−";
    const arrow = e.delay === true ? "-.->" : "-->";
    lines.push(`  ${s} ${arrow}|${sym}| ${t}`);
  }
  return lines.join("\n");
}

function loopJson(
  l: ExportLoop,
  titles: Record<string, string>,
  valence: Record<string, string>,
  notes: Record<string, string>,
): Record<string, unknown> {
  const key = loopNoteKey(l.loop, l.type);
  const out: Record<string, unknown> = { ...l };
  if (titles[key] !== undefined) out["title"] = titles[key];
  if (valence[key] !== undefined) out["valence"] = valence[key];
  if (notes[key] !== undefined) out["note"] = notes[key];
  return out;
}

/** Render a model in json | mermaid | markdown. */
export function render(
  fmt: string,
  modelId: string,
  name: string,
  nodes: ExportNode[],
  edges: ExportEdge[],
  loops: ExportLoop[],
  opts: RenderOpts = {},
): Rendered {
  fmt = fmt.toLowerCase();
  const notes = opts.notes ?? {};
  const valence = opts.valence ?? {};
  const titles = opts.titles ?? {};

  if (fmt === "json") {
    const loopsOut = loops.map((l) => loopJson(l, titles, valence, notes));
    const payload: Record<string, unknown> = {
      model: { id: modelId, name },
    };
    if (opts.hypothesis) payload["dynamic_hypothesis"] = opts.hypothesis;
    payload["graph"] = { nodes, edges };
    payload["loops"] = loopsOut;
    return { content: JSON.stringify(payload, null, 2), mime: "application/json", ext: "json" };
  }

  const mermaid = buildMermaid(nodes, edges);
  if (fmt === "mermaid") return { content: mermaid, mime: "text/plain", ext: "mmd" };

  // Markdown
  const md: string[] = [`# ${name}`, ""];
  if (opts.hypothesis) {
    const h = opts.hypothesis;
    const problem = String(h["problem"] ?? "").trim();
    const horizon = String(h["horizon"] ?? "").trim();
    const narrative = String(h["narrative"] ?? "").trim();
    if (problem || horizon || narrative) {
      md.push("## Dynamic hypothesis", "");
      if (problem) md.push(`**Behavior of interest:** ${problem}  `);
      if (horizon) md.push(`**Time horizon:** ${horizon}`);
      if (problem || horizon) md.push("");
      if (narrative) md.push(narrative, "");
    }
  }
  md.push("```mermaid", mermaid, "```", "");

  if (loops.length > 0) {
    md.push("## Feedback loops", "");
    for (const l of loops) {
      const cycle = l.loop.join(" → ");
      const key = loopNoteKey(l.loop, l.type);
      const val = valence[key];
      const tag =
        val === "virtuous" ? " _(virtuous cycle)_" : val === "vicious" ? " _(vicious cycle)_" : "";
      const lead: string[] = [];
      if (l.label) lead.push(`**${l.label}**`);
      const title = titles[key];
      if (title && title.trim().length > 0) lead.push(`**${title}**`);
      const leadStr = lead.length > 0 ? lead.join(" · ") + " · " : "";
      md.push(`- ${leadStr}**${l.type}** — ${cycle}${tag}`);
      const note = notes[key];
      if (note !== undefined) {
        for (const ln of note.split("\n")) md.push(ln.trim().length === 0 ? "  >" : `  > ${ln}`);
      }
    }
    md.push("");
  }
  return { content: md.join("\n"), mime: "text/markdown", ext: "md" };
}

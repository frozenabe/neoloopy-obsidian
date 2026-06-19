/**
 * Canvas color tokens — a direct port of `app/lib/theme/tokens.dart`
 * (`LoopyTokens.light` / `.dark`). Teal = reinforcing (R), amber = balancing
 * (B); violet (`live`) is the external-edit signal, plum (`claDepth`) is the
 * CLA worldview/myth marker. The active set follows Obsidian's theme.
 */

export interface Theme {
  dark: boolean;
  paper: string;
  surface: string;
  surface2: string;
  ink: string;
  ink2: string;
  ink3: string;
  line: string;
  line2: string;
  graphite: string;
  teal: string;
  tealSoft: string;
  tealInk: string;
  amber: string;
  amberSoft: string;
  amberInk: string;
  live: string;
  liveSoft: string;
  claDepth: string;
}

export const LIGHT: Theme = {
  dark: false,
  paper: "#FBFAF7",
  surface: "#FFFEFD",
  surface2: "#F4F3F0",
  ink: "#1F2329",
  ink2: "#585B61",
  ink3: "#6E7176",
  line: "#E0E0DC",
  line2: "#D0CFCB",
  graphite: "#4A4D53",
  teal: "#1C7E7E",
  tealSoft: "#D7F4F3",
  tealInk: "#005C5C",
  amber: "#B07412",
  amberSoft: "#FFEED3",
  amberInk: "#965719",
  live: "#756DCB",
  liveSoft: "#EEEEFF",
  claDepth: "#9B4FA6",
};

export const DARK: Theme = {
  dark: true,
  paper: "#14171D",
  surface: "#1F2329",
  surface2: "#0E1217",
  ink: "#EBEDEF",
  ink2: "#AEB1B6",
  ink3: "#83868C",
  line: "#32363C",
  line2: "#43484F",
  graphite: "#A0A5AC",
  teal: "#44BCBC",
  tealSoft: "#143D3C",
  tealInk: "#72D0D0",
  amber: "#EBAE51",
  amberSoft: "#4C3211",
  amberInk: "#F5C076",
  live: "#9690F1",
  liveSoft: "#33324E",
  claDepth: "#C481D2",
};

/** Pick the token set matching the document's current theme. */
export function resolveTheme(): Theme {
  const dark =
    typeof activeDocument !== "undefined" &&
    activeDocument.body.classList.contains("theme-dark");
  return dark ? DARK : LIGHT;
}

/**
 * Curated **group** palette — a direct port of `app/lib/theme/group_palette.dart`.
 * Eight soft fills that tint a variable by the *part of the system* it belongs
 * to. Every hue dodges the reserved bands (teal·R, amber·B, violet·live) so a
 * tinted node can never be mistaken for a loop or a live edit. `name` is the
 * controlled vocabulary stored on the node (lowercase), matching the app + MCP.
 */
export interface GroupSwatch {
  name: string;
  fillLight: string;
  inkLight: string;
  borderLight: string;
  fillDark: string;
  inkDark: string;
  borderDark: string;
}

/** Ordered 8-slot palette. Slot order is part of the vocabulary's identity. */
export const GROUP_PALETTE: GroupSwatch[] = [
  { name: "rose", fillLight: "#FFE8E5", inkLight: "#883C38", borderLight: "#EDC2BD", fillDark: "#512E2B", inkDark: "#FAADA6", borderDark: "#764B47" },
  { name: "magenta", fillLight: "#FFE7F3", inkLight: "#803B5F", borderLight: "#E8C1D2", fillDark: "#4E2E3D", inkDark: "#F2ACCC", borderDark: "#724A5D" },
  { name: "orchid", fillLight: "#FBE9FE", inkLight: "#714179", borderLight: "#DEC3E2", fillDark: "#463049", inkDark: "#E1B1E8", borderDark: "#684D6C" },
  { name: "blue", fillLight: "#E1F2FF", inkLight: "#2A5790", borderLight: "#B8D0EF", fillDark: "#263A54", inkDark: "#9CC7FF", borderDark: "#415A79" },
  { name: "azure", fillLight: "#DAF5FF", inkLight: "#006084", borderLight: "#ADD5E8", fillDark: "#173E4E", inkDark: "#81D0F3", borderDark: "#305F72" },
  { name: "green", fillLight: "#E1F7E4", inkLight: "#206635", borderLight: "#B8D8BD", fillDark: "#24412B", inkDark: "#99D5A5", borderDark: "#3F6246" },
  { name: "fern", fillLight: "#E9F5DD", inkLight: "#456117", borderLight: "#C4D5B2", fillDark: "#313E20", inkDark: "#B3D08F", borderDark: "#4E5F3A" },
  { name: "lime", fillLight: "#F2F2D8", inkLight: "#5D5A00", borderLight: "#D0D1AB", fillDark: "#3C3B19", inkDark: "#C9C982", borderDark: "#5B5B32" },
];

/** Look up a swatch by stored group name (case-insensitive); null = no group. */
export function groupSwatch(name?: string | null): GroupSwatch | null {
  if (!name) return null;
  const k = name.toLowerCase();
  return GROUP_PALETTE.find((g) => g.name === k) ?? null;
}

/** Resolve a swatch's fill/ink/border for the active theme. */
export function swatchFill(s: GroupSwatch, dark: boolean): string {
  return dark ? s.fillDark : s.fillLight;
}
export function swatchInk(s: GroupSwatch, dark: boolean): string {
  return dark ? s.inkDark : s.inkLight;
}
export function swatchBorder(s: GroupSwatch, dark: boolean): string {
  return dark ? s.borderDark : s.borderLight;
}

/** "#RRGGBB" + alpha[0..1] -> "rgba(r,g,b,a)". */
export function withAlpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

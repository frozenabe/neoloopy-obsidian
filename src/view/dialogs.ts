// Header-bar dialogs that mirror the native app's canvas header: the
// systems-thinking glossary (searchable) and the keyboard-shortcuts cheatsheet.
// Content is ported verbatim from the Flutter app so the two surfaces read the
// same; the shortcuts list reflects the plugin's ACTUAL keymap (Ctrl chords,
// no insights pane), not chords Obsidian reserves.

import { App, Modal } from "obsidian";
import {
  ChildInterface,
  InputBinding,
  QuantPatch,
  VariableFile,
  qualifiedRef,
  quantInputBindings,
} from "@neoloopy/cld-canvas";
import { equationModalModel, equationRefs, perElementInitial } from "../engine/panelModel";
import { keyboardAwareModal } from "./mobileModal";

const isNumeric = (s: string): boolean => {
  const t = s.trim();
  return t.length > 0 && !Number.isNaN(Number(t));
};

interface PromptOptions {
  title: string;
  placeholder?: string;
  initial?: string;
  cta?: string;
}

/**
 * A minimal single-line text prompt — the small modal the canvas uses to ask
 * for a model's title on create, and a new title on rename. Enter or the CTA
 * commits the trimmed value; Escape, Cancel, or the backdrop cancels; an empty
 * value never commits. Resolves exactly once: the entered string, or null on
 * cancel.
 */
export function promptText(app: App, opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => new PromptModal(app, opts, resolve).open());
}

class PromptModal extends Modal {
  private committed = false;

  constructor(
    app: App,
    private readonly opts: PromptOptions,
    private readonly resolve: (value: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.opts.title);
    this.modalEl.addClass("neoloopy-prompt-modal");
    const c = this.contentEl;

    const input = c.createEl("input", { type: "text", cls: "neoloopy-prompt-input" });
    input.value = this.opts.initial ?? "";
    if (this.opts.placeholder) input.placeholder = this.opts.placeholder;

    const actions = c.createDiv({ cls: "neoloopy-prompt-actions" });
    const ok = actions.createEl("button", { cls: "mod-cta", text: this.opts.cta ?? "OK" });
    const cancel = actions.createEl("button", { text: "Cancel" });

    const commit = (): void => {
      const value = input.value.trim();
      if (value.length === 0) return; // never commit an empty title
      this.committed = true;
      this.resolve(value);
      this.close();
    };
    ok.addEventListener("click", commit);
    cancel.addEventListener("click", () => this.close());
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        this.close();
      }
    });

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  onClose(): void {
    this.contentEl.empty();
    // Any close that did not go through `commit` (Escape, Cancel, backdrop) is a
    // cancellation — resolve null, exactly once.
    if (!this.committed) this.resolve(null);
  }
}

/**
 * The ƒx modal — view/edit a variable's *engineless* quantitative definition
 * (no simulation): the editable initial (stock) or equation (flow/aux) and its
 * units, plus the derived governing flow, per-element initial, and the variables
 * the equation uses. Save writes back via the `onSave` callback. The
 * engine-requiring sections from the app's editor (try-a-value, delay builder,
 * aging chain) are intentionally absent.
 */
export class EquationModal extends Modal {
  private kbTeardown: () => void = () => {};

  constructor(
    app: App,
    private readonly node: VariableFile,
    private readonly nodes: VariableFile[],
    private readonly onSave: (patch: QuantPatch) => Promise<void>,
    /** The linked child's public interface, pre-resolved by the caller; null
     *  when this node is not a subsystem anchor. Read-only preview. */
    private readonly iface: ChildInterface | null = null,
  ) {
    super(app);
  }

  onOpen(): void {
    const vm = equationModalModel(this.node, this.nodes);
    const varNames = this.nodes.map((n) => n.label || n.id);
    this.titleEl.setText(`ƒx  ${vm.title}`);
    this.modalEl.addClass("neoloopy-eq-modal");
    const c = this.contentEl;

    c.createDiv({
      cls: "neoloopy-eq-hint",
      text: "Quantitative definition — no simulation runs here.",
    });

    // Public-interface role in subsystem composition (read-only). Shown only when
    // this variable is exposed to a parent model; private variables show nothing.
    if (vm.visibility) {
      const vis = c.createDiv({ cls: "neoloopy-eq-vis" });
      vis.createSpan({
        cls: `neoloopy-eq-vischip is-${vm.visibility}`,
        text: vm.visibility === "input" ? "Public input" : "Public output",
      });
    }

    // Primary field: Initial value (stock) or Equation (flow/auxiliary).
    c.createDiv({ cls: "neoloopy-eq-label", text: vm.primaryLabel });
    const primary = c.createEl("input", { type: "text", cls: "neoloopy-eq-input" });
    primary.value = vm.primaryValue;

    // Stock: a live per-element hint (young → 10 · old → 0).
    if (vm.isStock) {
      const perEl = c.createDiv({ cls: "neoloopy-eq-perel" });
      const renderPerEl = (v: string): void => {
        const f = perElementInitial(v);
        perEl.setText(f ?? "");
        perEl.toggleClass("is-hidden", !f);
      };
      renderPerEl(vm.primaryValue);
      primary.addEventListener("input", () => renderPerEl(primary.value));
    }

    // Stock: read-only governing flow derived from the wired flows.
    if (vm.isStock && vm.governingFlow) {
      const gf = c.createDiv({ cls: "neoloopy-eq-section" });
      gf.createDiv({ cls: "neoloopy-eq-label", text: "Governing flow" });
      gf.createDiv({ cls: "neoloopy-eq-governing", text: vm.governingFlow });
    }

    // The variables the value uses, and any identifier that matches none —
    // recomputed live. A stock's constant / per-element initial is not analyzed.
    const usesBox = c.createDiv({ cls: "neoloopy-eq-section" });
    const analyzable = (v: string): boolean =>
      !vm.isStock || (perElementInitial(v) === undefined && !isNumeric(v));
    const renderUses = (v: string): void => {
      usesBox.empty();
      if (!analyzable(v)) return;
      const { referenced, unknown } = equationRefs(v, varNames);
      if (referenced.length === 0 && unknown.length === 0) return;
      usesBox.createDiv({ cls: "neoloopy-eq-label", text: "Uses" });
      const chips = usesBox.createDiv({ cls: "neoloopy-eq-chips" });
      for (const r of referenced) chips.createSpan({ cls: "neoloopy-eq-chip", text: r });
      for (const u of unknown) chips.createSpan({ cls: "neoloopy-eq-chip is-unknown", text: u });
      if (unknown.length > 0) {
        usesBox.createDiv({
          cls: "neoloopy-eq-warn",
          text: `Not defined in this model: ${unknown.join(", ")}`,
        });
      }
    };
    renderUses(vm.primaryValue);
    primary.addEventListener("input", () => renderUses(primary.value));

    // Subsystem interface (read-only) when this node drills into a child model.
    if (this.iface && (this.iface.outputs.length > 0 || this.iface.inputs.length > 0)) {
      this.renderInterface(c, this.iface);
    }

    // Units (both) with suggestions drawn from the model's existing units.
    c.createDiv({ cls: "neoloopy-eq-label", text: "Units" });
    const units = c.createEl("input", { type: "text", cls: "neoloopy-eq-input" });
    units.value = vm.units;
    if (vm.unitSuggestions.length > 0) {
      const listId = `neoloopy-units-${this.node.id}`;
      const dl = c.createEl("datalist");
      dl.id = listId;
      for (const u of vm.unitSuggestions) {
        const o = dl.createEl("option");
        o.value = u;
      }
      units.setAttribute("list", listId);
    }

    const actions = c.createDiv({ cls: "neoloopy-eq-actions" });
    const save = actions.createEl("button", { cls: "mod-cta", text: "Save" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    save.addEventListener("click", () => {
      const patch: QuantPatch = vm.isStock
        ? { initial: primary.value, units: units.value }
        : { equation: primary.value, units: units.value };
      save.disabled = true;
      void this.onSave(patch).then(
        () => this.close(),
        () => {
          save.disabled = false;
        },
      );
    });

    this.kbTeardown = keyboardAwareModal(this);
    window.setTimeout(() => primary.focus(), 0);
  }

  /**
   * The linked child model's public interface, read-only: the outputs it offers
   * (as qualified `Child.[Node]` references the parent can use) and the inputs it
   * expects, each with any parent-side binding declared on this anchor node.
   * Binding + publishing are quant authoring (app/CLI/MCP), so this never edits.
   */
  private renderInterface(parent: HTMLElement, iface: ChildInterface): void {
    const bindings = quantInputBindings(this.node);
    const boundExpr = (input: string): string => {
      const b = bindings.find(
        (x: InputBinding) => x.child === iface.qualifier && x.target === input,
      );
      return (b?.expr ?? "").trim();
    };

    const sec = parent.createDiv({ cls: "neoloopy-eq-section neoloopy-eq-subsystem" });
    sec.createDiv({ cls: "neoloopy-eq-label", text: `Subsystem · ${iface.qualifier}` });

    if (iface.outputs.length > 0) {
      sec.createDiv({ cls: "neoloopy-eq-sublabel", text: "Outputs" });
      const chips = sec.createDiv({ cls: "neoloopy-eq-chips" });
      for (const o of iface.outputs) {
        chips.createSpan({
          cls: "neoloopy-eq-chip is-output",
          text: qualifiedRef(iface.qualifier, o),
        });
      }
    }

    if (iface.inputs.length > 0) {
      sec.createDiv({ cls: "neoloopy-eq-sublabel", text: "Inputs" });
      for (const inp of iface.inputs) {
        const row = sec.createDiv({ cls: "neoloopy-eq-subrow" });
        row.createSpan({ cls: "neoloopy-eq-subname", text: inp });
        const expr = boundExpr(inp);
        row.createSpan({
          cls: `neoloopy-eq-subexpr${expr ? "" : " is-unbound"}`,
          text: expr || "unbound",
        });
      }
    }
  }

  onClose(): void {
    this.kbTeardown();
    this.contentEl.empty();
  }
}

interface GlossaryTerm {
  term: string;
  def: string;
}

// Ported from `app/lib/l10n/content_l10n.dart` (localizedGlossary). Source:
// David N. Ford, "A system dynamics glossary," System Dynamics Review
// 35(4):369–379 (2019), CC-BY.
const GLOSSARY: GlossaryTerm[] = [
  {
    term: "Causal loop diagram (CLD)",
    def: "A diagram of closed cause–effect linkages that captures how variables interrelate. CLDs identify and label feedback loops to aid understanding and dynamic reasoning — they are qualitative, not simulated.",
  },
  {
    term: "Causal link",
    def: "An arrow describing a relationship between two variables: its direction (cause → effect) and its polarity (same or opposite direction of change). A significant delay can be marked on the link.",
  },
  {
    term: "Link polarity (+ / −)",
    def: "A sign on a link. Positive (+) means the affected variable moves in the same direction as its cause; negative (−) means it moves in the opposite direction. Sometimes written S (same) and O (opposite).",
  },
  {
    term: "Feedback loop",
    def: "A sequence of variables and links that forms a closed ring, so a change eventually feeds back to its own origin. Loops are the heart of systems thinking.",
  },
  {
    term: "Loop polarity",
    def: "Whether a loop is reinforcing or balancing, found from the algebraic product of all link polarities around it. An even number of − links → reinforcing; odd → balancing.",
  },
  {
    term: "Reinforcing loop (R)",
    def: "A loop whose links strengthen movement in a given direction — the engine of exponential growth or collapse. Also called a positive feedback loop.",
  },
  {
    term: "Balancing loop (B)",
    def: "A loop whose net effect limits or constrains change, seeking equilibrium or a target state. Also called negative, goal-seeking, or controlling feedback.",
  },
  {
    term: "Virtuous cycle",
    def: "A reinforcing (amplifying) structure that yields desirable results — success building on success.",
  },
  {
    term: "Vicious cycle",
    def: "A reinforcing (amplifying) structure that yields undesirable results — a downward spiral.",
  },
  {
    term: "Delay",
    def: "A phenomenon in which one variable's effect on another is not immediate; the output lags the input. Delays are a common source of oscillation and overshoot.",
  },
  {
    term: "Feedback",
    def: "When the result of a causal impact returns to influence the original cause. The basis of both reinforcing and balancing loops.",
  },
  {
    term: "Endogenous variable",
    def: "Internal to the system — its value is shaped by other variables within the model boundary. An endogenous view looks for causes and solutions inside the system.",
  },
  {
    term: "Exogenous variable",
    def: "An external input that affects the system but is not affected by it. Relying heavily on exogenous variables is \"open-loop\" thinking.",
  },
  {
    term: "System boundary",
    def: "The border enclosing the structure needed to generate the behavior of concern, excluding everything irrelevant to the problem.",
  },
  {
    term: "Mental model",
    def: "A limited internal representation of a system's structure and the assumptions you hold about it. CLDs make mental models explicit and shareable.",
  },
  {
    term: "System archetype",
    def: "A generic, recurring feedback structure (and its typical behavior and story) that describes a common problem and potential solutions — e.g. Limits to Growth, Fixes that Fail, Shifting the Burden.",
  },
  {
    term: "Loop dominance",
    def: "A condition in a multi-loop system where one loop is strong enough to determine the behavior in a given period. Behavior often shifts as dominance moves between loops.",
  },
  {
    term: "Closed-loop thinking",
    def: "Approaching a problem with an endogenous perspective — focusing on the feedback loops that internally generate behavior, rather than blaming outside forces.",
  },
  {
    term: "Systems thinking",
    def: "Using conceptual models to understand how feedback, delays, and decisions in a structure generate behavior over time — seeing interrelationships and change over time rather than snapshots.",
  },
  {
    term: "Policy resistance",
    def: "When policies are delayed, diluted, or defeated by the system's own (often balancing) feedbacks reacting to them.",
  },
  {
    term: "Unintended consequence",
    def: "An unplanned, usually undesirable side effect of well-meaning action, often appearing after a delay and away from where the action was taken.",
  },
  {
    term: "Counterintuitive behavior",
    def: "When actions assuming an obvious solution produce surprising or paradoxical results — often intensifying the very problem they meant to solve.",
  },
  {
    term: "High-leverage point",
    def: "A spot where a small change has a large effect.",
  },
];

const GLOSSARY_SOURCE =
  "Adapted from David N. Ford, “A system dynamics glossary,” System Dynamics Review 35(4):369–379 (2019), CC-BY.";

export class GlossaryModal extends Modal {
  private kbTeardown: () => void = () => {};

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Systems-thinking glossary");
    this.modalEl.addClass("neoloopy-glossary-modal");
    const { contentEl } = this;

    const search = contentEl.createEl("input", {
      type: "text",
      cls: "neoloopy-glossary-search",
      attr: { placeholder: "Search terms…" },
    });
    const list = contentEl.createDiv({ cls: "neoloopy-glossary-list" });

    const render = (q: string): void => {
      list.empty();
      const ql = q.trim().toLowerCase();
      const items = ql
        ? GLOSSARY.filter(
            (g) => g.term.toLowerCase().includes(ql) || g.def.toLowerCase().includes(ql),
          )
        : GLOSSARY;
      if (items.length === 0) {
        list.createDiv({ cls: "neoloopy-glossary-empty", text: "No matches." });
        return;
      }
      for (const g of items) {
        const row = list.createDiv({ cls: "neoloopy-glossary-row" });
        row.createDiv({ cls: "neoloopy-glossary-term", text: g.term });
        row.createDiv({ cls: "neoloopy-glossary-def", text: g.def });
      }
    };

    render("");
    search.addEventListener("input", () => render(search.value));
    window.setTimeout(() => search.focus(), 0);

    contentEl.createDiv({ cls: "neoloopy-glossary-source", text: GLOSSARY_SOURCE });
    this.kbTeardown = keyboardAwareModal(this);
  }

  onClose(): void {
    this.kbTeardown();
    this.contentEl.empty();
  }
}

interface ShortcutRow {
  keys: string;
  desc: string;
}
interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

// Reflects the plugin's real keymap (canvasView.onKeyDown), grouped like the
// app's `_showShortcuts`. Uses the Ctrl chords that work in Obsidian (Cmd+E/
// Cmd+T are reserved by Obsidian's keymap), and omits app-only surfaces.
const SHORTCUTS: ShortcutGroup[] = [
  {
    title: "Navigate",
    rows: [
      { keys: "Tab / ⇧Tab", desc: "cycle variables" },
      { keys: "E / ⇧E", desc: "cycle a node's edges" },
      { keys: "O / ⇧O", desc: "cycle feedback loops" },
      { keys: "Arrows", desc: "pan canvas (nothing selected)" },
      { keys: "+ / − / 0", desc: "zoom in / out / fit all" },
      { keys: "Esc", desc: "clear selection" },
    ],
  },
  {
    title: "Variables",
    rows: [
      { keys: "N", desc: "new variable (then name it)" },
      { keys: "Enter / F2", desc: "rename selected variable" },
      { keys: "Arrows", desc: "nudge selected node (⇧ = larger)" },
      { keys: "L", desc: "start link from node; Enter completes" },
      { keys: "Delete / ⌫", desc: "delete selection" },
    ],
  },
  {
    title: "Edges",
    rows: [
      { keys: "Enter", desc: "toggle the edge menu" },
      { keys: "Tab / ⇧Tab", desc: "walk to target / source node" },
    ],
  },
  {
    title: "Loops & notes",
    rows: [
      { keys: "O / ⇧O", desc: "select a loop badge" },
      { keys: "Enter", desc: "open the selected loop's note" },
    ],
  },
  {
    title: "Commands",
    rows: [
      { keys: "Ctrl + E", desc: "export" },
      { keys: "Ctrl + T", desc: "spread out layout" },
      { keys: "Ctrl + /  or  ?", desc: "this cheatsheet" },
    ],
  },
];

export class ShortcutsModal extends Modal {
  private kbTeardown: () => void = () => {};

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Keyboard shortcuts");
    this.modalEl.addClass("neoloopy-shortcuts-modal");
    const c = this.contentEl;
    for (const g of SHORTCUTS) {
      c.createDiv({ cls: "neoloopy-sc-group", text: g.title });
      for (const r of g.rows) {
        const row = c.createDiv({ cls: "neoloopy-sc-row" });
        const keys = row.createDiv({ cls: "neoloopy-sc-keys" });
        keys.createSpan({ cls: "neoloopy-sc-key", text: r.keys });
        row.createDiv({ cls: "neoloopy-sc-desc", text: r.desc });
      }
    }
    this.kbTeardown = keyboardAwareModal(this);
  }

  onClose(): void {
    this.kbTeardown();
    this.contentEl.empty();
  }
}

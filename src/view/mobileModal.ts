import { Modal, Platform } from "obsidian";

/**
 * Keep a modal usable while the iOS/Android soft keyboard is open.
 *
 * Obsidian centers (or bottom-slides) a modal, so the keyboard covers its lower
 * half — on a tall modal like ƒx that hides the inputs and the Save/Cancel row,
 * leaving the user to type blind. Here we pin the modal to the top of the
 * *visual* viewport (which shrinks when the keyboard opens — the WebKit analogue
 * of Flutter's `MediaQuery.viewInsets`, the same signal the canvas editor uses)
 * and cap the scrollable content to the band that stays visible above the
 * keyboard, so every field and button is reachable by scrolling.
 *
 * No-op on desktop. Call the returned teardown from the modal's `onClose`.
 */
export function keyboardAwareModal(modal: Modal): () => void {
  const vv = window.visualViewport;
  if (!Platform.isMobile || !vv) return () => {};

  const box = modal.modalEl;
  const content = modal.contentEl;
  box.addClass("neoloopy-kbaware-modal");
  content.addClass("neoloopy-kbaware-content");

  // Drive the position + scroll cap through CSS custom properties (the stylesheet
  // consumes them), rather than writing layout styles inline.
  const apply = (): void => {
    // Sit just below the safe area (iOS notch / Dynamic Island / camera) — the
    // stylesheet adds env(safe-area-inset-top) to this gap so the modal clears
    // the camera on any device. `safeTopReserve` is a conservative estimate of
    // that inset used only for the height cap, so the modal still fits above the
    // keyboard on a notched phone.
    const gap = 10;
    const bottomGap = 12;
    const safeTopReserve = 56;
    box.setCssProps({ "--neoloopy-kb-top": `${vv.offsetTop + gap}px` });
    const reserved = safeTopReserve + gap + modal.titleEl.offsetHeight + bottomGap;
    content.setCssProps({
      "--neoloopy-kb-maxh": `${Math.max(140, vv.height - reserved)}px`,
    });
  };
  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);

  return () => {
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
    // The classes carry the layout; removing them disables the rules that read
    // the custom properties (the modal element is discarded on close anyway).
    box.removeClass("neoloopy-kbaware-modal");
    content.removeClass("neoloopy-kbaware-content");
  };
}

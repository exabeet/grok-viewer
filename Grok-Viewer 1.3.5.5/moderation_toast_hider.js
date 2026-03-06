(() => {
  const STORAGE_KEY = "gvHideModerationToast";
  const STYLE_ID = "gv-hide-moderation-toast";
  const STYLE_CSS = `ol[data-sonner-toaster] li[data-sonner-toast][data-type="error"] {
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
  transform: translateX(-500000px) !important;
}`;

  const applyStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE_CSS;
    document.documentElement.appendChild(style);
  };

  const removeStyle = () => {
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
  };

  const setEnabled = (enabled) => {
    if (enabled) applyStyle();
    else removeStyle();
  };

  const init = () => {
    chrome.storage.local.get(STORAGE_KEY, (data) => {
      setEnabled(Boolean(data && data[STORAGE_KEY]));
    });
  };

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "GV_SET_HIDE_MOD_TOAST") return;
    setEnabled(Boolean(message.enabled));
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (!changes[STORAGE_KEY]) return;
    setEnabled(Boolean(changes[STORAGE_KEY].newValue));
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

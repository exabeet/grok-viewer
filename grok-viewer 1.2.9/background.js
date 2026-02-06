(() => {
  const openViewerWindow = (incognito) => {
    chrome.windows.create({
      url: "https://grok.com/imagine/favorites?grokViewer=1",
      type: "popup",
      width: 1200,
      height: 820,
      incognito: Boolean(incognito)
    });
  };

  chrome.action.onClicked.addListener((tab) => {
    openViewerWindow(tab && tab.incognito);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.action === "openViewerWindow") {
      openViewerWindow(sender && sender.tab && sender.tab.incognito);
      sendResponse({ ok: true });
      return true;
    }

    if (message && message.action === "grokViewerDownloadUrl") {
      const url = message.postUrl || message.url;
      if (!url) {
        sendResponse({ ok: false, error: "no-url" });
        return true;
      }
      chrome.downloads.download({ url }, (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true, downloadId });
      });
      return true;
    }

    if (message && message.action === "grokViewerProxyToTab") {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      if (!tabId) {
        sendResponse({ ok: false, error: "no-tab" });
        return true;
      }
      chrome.tabs.sendMessage(tabId, message.payload || {}, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true, response });
      });
      return true;
    }

    if (message && message.action === "grokViewerDeleteViaMain") {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      const id = message.id;
      if (!tabId || !id) {
        sendResponse({ ok: false, error: "missing-tab-or-id" });
        return true;
      }
      chrome.scripting.executeScript(
        {
          target: { tabId },
          world: "MAIN",
          func: (postId) =>
            fetch("/rest/media/post/delete", {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: postId })
            })
              .then(async (res) => {
                let bodyText = "";
                try {
                  bodyText = await res.text();
                } catch (e) {
                  bodyText = "";
                }
                return { ok: res.ok, status: res.status, body: bodyText };
              })
              .catch((err) => ({ ok: false, status: 0, body: String(err) })),
          args: [id]
        },
        (results) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          const payload = results && results[0] ? results[0].result : null;
          sendResponse(payload || { ok: false, status: 0, body: "" });
        }
      );
      return true;
    }

    if (message && message.action === "grokViewerSetHideModToast") {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      if (!tabId) {
        sendResponse({ ok: false, error: "no-tab" });
        return true;
      }
      chrome.tabs.sendMessage(tabId, { type: "GV_SET_HIDE_MOD_TOAST", enabled: !!message.enabled }, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true, response });
      });
      return true;
    }

    return false;
  });
})();

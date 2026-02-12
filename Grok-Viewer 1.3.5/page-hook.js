(() => {
  if (window.__grokViewerHooked) return;
  window.__grokViewerHooked = true;

  const post = (url) => {
    if (!url) return;
    window.postMessage({ source: "grok-viewer", type: "videoUrl", url, pageUrl: window.location.href }, "*");
  };

  const postRegenEvent = (type, extra) => {
    if (!type) return;
    window.postMessage(
      {
        source: "grok-viewer",
        type,
        pageUrl: window.location.href,
        ...(extra || {})
      },
      "*"
    );
  };

  const rememberHeader = (name, value) => {
    const key = String(name || "").trim().toLowerCase();
    const val = String(value || "").trim();
    if (!key || !val) return;
    if (key === "x-statsig-id") {
      window.__grokViewerLastStatsigId = val;
      return;
    }
    if (key === "x-xai-request-id") {
      window.__grokViewerLastXaiRequestId = val;
    }
  };

  

  const captureFetchHeaders = (input, init) => {
    if (init && init.headers) captureHeaders(init.headers);
    if (input && typeof input === "object" && input.headers) captureHeaders(input.headers);
  };

  const parseLine = (line) => {
    if (!line) return;
    try {
      const obj = JSON.parse(line);
      const responseNode = obj && obj.result && obj.result.response ? obj.result.response : null;
      if (!responseNode || typeof responseNode !== "object") return;
      const queryAction = responseNode.queryAction;
      if (queryAction && queryAction.type) {
        postRegenEvent("regenQuery", { queryType: String(queryAction.type || "") });
      }
      const stream = responseNode.streamingVideoGenerationResponse;
      if (stream && typeof stream === "object") {
        const progress = Number(stream.progress);
        postRegenEvent("regenStream", {
          progress: Number.isFinite(progress) ? progress : null,
          moderated: stream.moderated === true,
          videoPostId: stream.videoPostId ? String(stream.videoPostId) : "",
          videoUrl: stream.videoUrl ? String(stream.videoUrl) : "",
          thumbnailImageUrl: stream.thumbnailImageUrl ? String(stream.thumbnailImageUrl) : "",
          parentPostId: stream.parentPostId ? String(stream.parentPostId) : ""
        });
        if (stream.videoUrl) {
          post(stream.videoUrl);
        }
      }
    } catch (error) {
      // ignore parse errors
    }
  };

  const parseText = (text) => {
    if (!text) return;
    const lines = text.split(/\n+/);
    for (let i = 0; i < lines.length; i += 1) {
      parseLine(lines[i]);
    }
  };

  const parseStream = (stream) => {
    if (!stream || !stream.getReader) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const pump = () => {
      reader
        .read()
        .then((result) => {
          if (result.value) {
            buffer += decoder.decode(result.value, { stream: !result.done });
            const parts = buffer.split(/\n+/);
            buffer = parts.pop() || "";
            for (let i = 0; i < parts.length; i += 1) {
              parseLine(parts[i]);
            }
          }
          if (!result.done) {
            pump();
          } else if (buffer) {
            parseLine(buffer);
          }
        })
        .catch(() => {});
    };

    pump();
  };

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function fetchWrapper() {
      try {
        captureFetchHeaders(arguments[0], arguments[1]);
      } catch (error) {}
      return originalFetch.apply(this, arguments).then((response) => {
        try {
          const url = response.url || "";
          if (url.indexOf("/rest/app-chat/conversations/new") !== -1) {
            const statusCode = Number(response.status || 0);
            const clone = response.clone();
            if (!response.ok) {
              clone
                .text()
                .then((text) => {
                  const sample = String(text || "").slice(0, 1600);
                  const challengeDetected = /just a moment|enable javascript and cookies|cf[-_]?challenge|challenge-platform/i.test(
                    sample
                  );
                  postRegenEvent("regenHttp", {
                    status: statusCode,
                    challengeDetected,
                    errorHint: challengeDetected ? "cloudflare-challenge" : "http-error"
                  });
                })
                .catch(() => {
                  postRegenEvent("regenHttp", { status: statusCode, challengeDetected: false, errorHint: "http-error" });
                });
            } else {
              postRegenEvent("regenHttp", { status: statusCode, challengeDetected: false, errorHint: "" });
              if (clone.body && clone.body.getReader) {
                parseStream(clone.body);
              } else {
                clone.text().then(parseText).catch(() => {});
              }
            }
          }
        } catch (error) {
          // ignore
        }
        return response;
      });
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR && OriginalXHR.prototype) {
    const originalOpen = OriginalXHR.prototype.open;
    OriginalXHR.prototype.open = function openWrapper(method, url) {
      this.__grokViewerUrl = url;
      return originalOpen.apply(this, arguments);
    };
    const originalSetRequestHeader = OriginalXHR.prototype.setRequestHeader;
    if (originalSetRequestHeader) {
      OriginalXHR.prototype.setRequestHeader = function setHeaderWrapper(name, value) {
        try {
          rememberHeader(name, value);
        } catch (error) {}
        return originalSetRequestHeader.apply(this, arguments);
      };
    }
    const originalSend = OriginalXHR.prototype.send;
    OriginalXHR.prototype.send = function sendWrapper() {
      this.addEventListener("load", () => {
        try {
          if (
            this.__grokViewerUrl &&
            this.__grokViewerUrl.indexOf("/rest/app-chat/conversations/new") !== -1
          ) {
            const statusCode = Number(this.status || 0);
            const bodyText = String(this.responseText || "");
            const challengeDetected =
              statusCode >= 400 &&
              /just a moment|enable javascript and cookies|cf[-_]?challenge|challenge-platform/i.test(bodyText.slice(0, 1600));
            postRegenEvent("regenHttp", {
              status: statusCode,
              challengeDetected,
              errorHint: statusCode >= 400 ? (challengeDetected ? "cloudflare-challenge" : "http-error") : ""
            });
            parseText(this.responseText || "");
          }
        } catch (error) {
          // ignore
        }
      });
      return originalSend.apply(this, arguments);
    };
  }
})();

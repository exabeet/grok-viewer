(() => {
  const SETTINGS_KEY = "grokViewerSettings";
  const IMAGINE_URL = "https://grok.com/imagine";

  const sanitizeFolderPath = (value) => {
    if (!value) return "";
    return String(value)
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/{2,}/g, "/")
      .replace(/\.\./g, "")
      .replace(/[^a-zA-Z0-9/_-]/g, "")
      .replace(/\/+$/, "");
  };

  const openViewerWindow = (incognito) => {
    chrome.windows.create({
      url: "https://grok.com/imagine/favorites?grokViewer=1",
      type: "popup",
      width: 1200,
      height: 820,
      incognito: Boolean(incognito)
    });
  };

  const getDownloadSettingsUrls = () => {
    const ua = (navigator.userAgent || "").toLowerCase();
    const urls = [];
    if (ua.includes("opr") || ua.includes("opera")) urls.push("opera://settings/downloads");
    if (ua.includes("brave")) urls.push("brave://settings/downloads");
    urls.push("chrome://settings/downloads");
    return urls;
  };

  const tabsQuery = (queryInfo) =>
    new Promise((resolve) => {
      chrome.tabs.query(queryInfo, (tabs) => {
        if (chrome.runtime.lastError) {
          resolve([]);
          return;
        }
        resolve(Array.isArray(tabs) ? tabs : []);
      });
    });

  const tabUpdate = (tabId, props) =>
    new Promise((resolve, reject) => {
      chrome.tabs.update(tabId, props, (tab) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "tab-update-failed"));
          return;
        }
        resolve(tab || null);
      });
    });

  const tabCreate = (props) =>
    new Promise((resolve, reject) => {
      chrome.tabs.create(props, (tab) => {
        if (chrome.runtime.lastError || !tab || !tab.id) {
          reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || "tab-create-failed"));
          return;
        }
        resolve(tab);
      });
    });

  const sendMessageToTab = (tabId, payload) =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, payload, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message || "tab-message-failed" });
          return;
        }
        resolve(response || { ok: false, error: "tab-no-response" });
      });
    });

  const ensureImagineTargetTab = async () => {
    const tabs = await tabsQuery({ url: ["https://grok.com/imagine*", "https://grok.com/imagine/favorites*"] });
    let target = tabs.find((tab) => tab.active && tab.windowId === chrome.windows.WINDOW_ID_CURRENT) || tabs[0] || null;
    if (!target || !target.id) {
      target = await tabCreate({ url: IMAGINE_URL, active: true });
    } else {
      const url = String(target.url || "");
      const needsImagine = !/\/imagine(?:[/?#]|$)/i.test(url) || /\/imagine\/favorites/i.test(url);
      if (needsImagine) {
        target = await tabUpdate(target.id, { url: IMAGINE_URL, active: true });
      } else {
        target = await tabUpdate(target.id, { active: true });
      }
    }
    await waitForTabComplete(target.id, 45000);
    return target;
  };

  const NATIVE_REGEN_DIAG_ENABLED = false;
  const nativeRegenSessions = new Map();
  const nativeRegenByTargetTab = new Map();

  const sendNativeRegenEvent = (session, payload) => {
    if (!session || !session.viewerTabId) return;
    chrome.tabs.sendMessage(
      session.viewerTabId,
      {
        action: "grokViewerRegenNativeEvent",
        requestId: session.requestId,
        ...(payload || {})
      },
      () => {
        if (chrome.runtime.lastError) {
          // viewer tab can be closed or reloaded while regen tab is still active
        }
      }
    );
  };

  const clearNativeRegenSession = (requestId) => {
    const session = nativeRegenSessions.get(requestId);
    if (!session) return;
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
      session.timeoutId = null;
    }
    if (session.progressPollId) {
      clearInterval(session.progressPollId);
      session.progressPollId = null;
    }
    nativeRegenSessions.delete(requestId);
    if (session.targetTabId) nativeRegenByTargetTab.delete(session.targetTabId);
    if (session.targetTabId) {
      chrome.tabs.remove(session.targetTabId, () => {
        if (chrome.runtime.lastError) {
          // tab can already be closed by user/navigation
        }
      });
    }
    if (session.hiddenWindowId) {
      chrome.windows.remove(session.hiddenWindowId, () => {});
    }
  };

  const finishNativeRegenSession = (requestId, payload) => {
    const session = nativeRegenSessions.get(requestId);
    if (!session) return;
    sendNativeRegenEvent(session, payload || {});
    clearNativeRegenSession(requestId);
  };

  const waitForTabComplete = (tabId, timeoutMs = 45000) =>
    new Promise((resolve, reject) => {
      let done = false;
      let timer = null;
      const cleanup = () => {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const onUpdated = (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId) return;
        if (changeInfo && changeInfo.status === "complete") {
          cleanup();
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          cleanup();
          reject(new Error(chrome.runtime.lastError.message || "tab-get-failed"));
          return;
        }
        if (tab && tab.status === "complete") {
          cleanup();
          resolve();
        }
      });
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("tab-load-timeout"));
      }, Math.max(4000, Number(timeoutMs) || 45000));
    });

  const createNativeRegenTab = (url) =>
    new Promise((resolve, reject) => {
      chrome.tabs.create({ url, active: false }, (createdTab) => {
        if (chrome.runtime.lastError || !createdTab || !createdTab.id) {
          reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || "tab-create-failed"));
          return;
        }
        resolve({
          tabId: createdTab.id,
          windowId: createdTab.windowId || null,
          hiddenWindowId: null
        });
      });
    });

  const startNativeRegenProgressPolling = (session) => {
    if (!session || !session.requestId || !session.targetTabId || session.progressPollId) return;
    session.progressProbeInFlight = false;
    session.lastProgress = Number.isFinite(Number(session.lastProgress))
      ? Math.max(0, Math.min(100, Math.round(Number(session.lastProgress))))
      : 1;
    session.lastProbeSeq = Number.isFinite(Number(session.lastProbeSeq)) ? Number(session.lastProbeSeq) : 0;
    session.hundredTickCount = Number.isFinite(Number(session.hundredTickCount)) ? Number(session.hundredTickCount) : 0;
    session.highProgressTickCount = Number.isFinite(Number(session.highProgressTickCount))
      ? Number(session.highProgressTickCount)
      : 0;
    session.lastDiagSentAt = Number.isFinite(Number(session.lastDiagSentAt)) ? Number(session.lastDiagSentAt) : 0;
    session.progressPollId = setInterval(() => {
      if (session.progressProbeInFlight) return;
      if (!nativeRegenSessions.has(session.requestId)) return;
      session.progressProbeInFlight = true;
      chrome.scripting.executeScript(
        {
          target: { tabId: session.targetTabId },
          world: "MAIN",
          func: (sourcePostId, requestToken) => {
            const clamp = (value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
            const parseProgressValue = (raw) => {
              if (raw === null || raw === undefined) return null;
              const text = String(raw).trim();
              if (!text) return null;
              const pctMatch = text.match(/(\d{1,3})(?:\.\d+)?\s*%/);
              if (pctMatch) {
                const parsed = Number(pctMatch[1]);
                return Number.isFinite(parsed) ? clamp(parsed) : null;
              }
              const numMatch = text.match(/^(\d{1,3})(?:\.\d+)?$/);
              if (numMatch) {
                const parsed = Number(numMatch[1]);
                if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) return clamp(parsed);
              }
              return null;
            };
            const normalizeUrl = (url) => {
              const raw = String(url || "").trim();
              if (!raw) return "";
              if (raw.startsWith("blob:")) return "";
              if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
              if (raw.startsWith("//")) return `${window.location.protocol}${raw}`;
              if (raw.startsWith("users/") || raw.startsWith("/users/")) return `https://assets.grok.com/${raw.replace(/^\/+/, "")}`;
              if (raw.startsWith("/imagine-public/")) return `https://imagine-public.x.ai${raw}`;
              if (raw.startsWith("imagine-public/")) return `https://imagine-public.x.ai/${raw}`;
              try {
                return new URL(raw, window.location.origin).toString();
              } catch (error) {
                return raw;
              }
            };
            const collectRoots = () => {
              const roots = [document];
              const seen = new Set([document]);
              const queue = [document.documentElement];
              while (queue.length) {
                const el = queue.shift();
                if (!el || !(el instanceof Element)) continue;
                if (el.shadowRoot && !seen.has(el.shadowRoot)) {
                  seen.add(el.shadowRoot);
                  roots.push(el.shadowRoot);
                  const nested = el.shadowRoot.querySelectorAll("*");
                  for (let i = 0; i < nested.length; i += 1) queue.push(nested[i]);
                }
                const children = el.children || [];
                for (let i = 0; i < children.length; i += 1) queue.push(children[i]);
              }
              return roots;
            };
            const queryAllDeep = (selector) => {
              const roots = collectRoots();
              const out = [];
              const seen = new Set();
              for (let i = 0; i < roots.length; i += 1) {
                let nodes = [];
                try {
                  nodes = Array.from(roots[i].querySelectorAll(selector));
                } catch (error) {
                  nodes = [];
                }
                for (let j = 0; j < nodes.length; j += 1) {
                  const node = nodes[j];
                  if (!node || seen.has(node)) continue;
                  seen.add(node);
                  out.push(node);
                }
              }
              return out;
            };
            const isDomReadable = (node) => {
              if (!node || !(node instanceof Element)) return false;
              const style = window.getComputedStyle(node);
              if (!style) return false;
              if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) return false;
              return true;
            };
            const isVisible = (node) => {
              if (!isDomReadable(node)) return false;
              const rect = node.getBoundingClientRect();
              if (!rect || rect.width <= 0 || rect.height <= 0) return false;
              return true;
            };
            const isDisabled = (node) => {
              if (!node || !(node instanceof Element)) return true;
              if (node.disabled) return true;
              const ariaDisabled = String(node.getAttribute ? node.getAttribute("aria-disabled") || "" : "").toLowerCase();
              return ariaDisabled === "true";
            };

            const tokenText = String(requestToken || "").trim();
            const probeRaw = window.__grokViewerNativeRegenProbe;
            const probe =
              probeRaw &&
              typeof probeRaw === "object" &&
              (!tokenText || String(probeRaw.token || "").trim() === tokenText)
                ? probeRaw
                : null;
            const probeSeq = probe && Number.isFinite(Number(probe.seq)) ? Number(probe.seq) : 0;
            const probeProgress =
              probe &&
              probe.progress !== null &&
              probe.progress !== undefined &&
              Number.isFinite(Number(probe.progress))
                ? clamp(Number(probe.progress))
                : null;
            const probeModerated = probe && probe.moderated === true;
            const probeStatus = probe && Number.isFinite(Number(probe.httpStatus)) ? Number(probe.httpStatus) : 0;
            const probeRequestSeen = probe && probe.requestSeen === true;
            const probeStreamCount = probe && Number.isFinite(Number(probe.streamCount)) ? Number(probe.streamCount) : 0;
            const probeVideoPostId = probe && probe.videoPostId ? String(probe.videoPostId) : "";
            const probeVideoUrl = probe && probe.videoUrl ? normalizeUrl(String(probe.videoUrl)) : "";
            const probeThumbnailImageUrl =
              probe && probe.thumbnailImageUrl ? normalizeUrl(String(probe.thumbnailImageUrl)) : "";
            const probeParentPostId = probe && probe.parentPostId ? String(probe.parentPostId) : "";

            const lower = (value) => String(value || "").toLowerCase();
            const hasGenerationHint = (value) =>
              /(generating|queued|rendering|processing|creating video|create video|video generation|generation)/i.test(
                String(value || "")
              );
            const iconSelector = ".lucide-film, svg.lucide-film, [class*='lucide-film']";
            let domProgress = null;
            let domScore = -1;
            let generationHintVisible = false;
            const assignDomProgress = (value, score) => {
              const parsed = parseProgressValue(value);
              if (parsed === null) return;
              const normalizedScore = Number.isFinite(Number(score)) ? Number(score) : 0;
              if (normalizedScore < domScore) return;
              if (normalizedScore === domScore && domProgress !== null && parsed <= domProgress) return;
              domScore = normalizedScore;
              domProgress = parsed;
            };

            const filmIcons = queryAllDeep(iconSelector);
            for (let i = 0; i < filmIcons.length; i += 1) {
              let node = filmIcons[i];
              for (let depth = 0; node && depth < 8; depth += 1) {
                if (node instanceof Element && isDomReadable(node)) {
                  const text = String(node.textContent || "");
                  if (hasGenerationHint(text)) generationHintVisible = true;
                  const matches = text.match(/\b\d{1,3}(?:\.\d+)?\s*%/g) || [];
                  for (let m = 0; m < matches.length; m += 1) {
                    const score = 85 - depth * 8 + (hasGenerationHint(text) ? 20 : 0);
                    assignDomProgress(matches[m], score);
                  }
                  const ariaNow = node.getAttribute ? node.getAttribute("aria-valuenow") : "";
                  assignDomProgress(ariaNow, 80 - depth * 8);
                }
                node = node && node.parentElement ? node.parentElement : null;
              }
            }

            const progressNodes = queryAllDeep(
              '[role="progressbar"], progress, [aria-valuenow], [data-progress], [data-testid*="progress" i], [class*="progress" i], [class*="generat" i], [class*="render" i]'
            );
            for (let i = 0; i < progressNodes.length; i += 1) {
              const node = progressNodes[i];
              if (!isDomReadable(node)) continue;
              const marker = lower(
                [
                  node.className || "",
                  node.id || "",
                  node.getAttribute ? node.getAttribute("data-testid") || "" : "",
                  node.getAttribute ? node.getAttribute("aria-label") || "" : "",
                  node.getAttribute ? node.getAttribute("title") || "" : ""
                ].join(" ")
              );
              const text = lower(node.textContent || "");
              let score = 0;
              if (/generat|render|queue|process/.test(marker)) score += 35;
              if (marker.includes("progress")) score += 10;
              if (hasGenerationHint(text)) score += 25;
              if (/generat|render|queue|process/.test(marker) || hasGenerationHint(text)) generationHintVisible = true;
              if (node.querySelector && node.querySelector(iconSelector)) score += 25;
              if (
                node.closest &&
                node.closest(
                  '[role="slider"], [aria-label*="seek" i], [class*="seek" i], [class*="scrub" i], [class*="timeline" i], [class*="volume" i], [data-testid*="player" i], [class*="player" i], video'
                )
              ) {
                score -= 60;
              }
              if (score < 15) continue;
              const values = [
                node.getAttribute ? node.getAttribute("aria-valuenow") : "",
                node.getAttribute ? node.getAttribute("data-progress") : "",
                node.getAttribute ? node.getAttribute("value") : "",
                node.getAttribute ? node.getAttribute("aria-value") : "",
                node.textContent || ""
              ];
              for (let j = 0; j < values.length; j += 1) {
                assignDomProgress(values[j], score);
              }
            }

            if (domProgress === null) {
              const filmPercentNodes = queryAllDeep(`${iconSelector}, [class*="film" i], [data-testid*="film" i]`);
              for (let i = 0; i < filmPercentNodes.length; i += 1) {
                let node = filmPercentNodes[i];
                for (let depth = 0; node && depth < 10; depth += 1) {
                  if (node instanceof Element && isDomReadable(node)) {
                    const text = String(node.textContent || "");
                    const matches = text.match(/\b\d{1,3}(?:\.\d+)?\s*%/g) || [];
                    if (matches.length) {
                      for (let m = 0; m < matches.length; m += 1) {
                        assignDomProgress(matches[m], 70 - depth * 5);
                      }
                    }
                  }
                  node = node && node.parentElement ? node.parentElement : null;
                }
              }
            }

            if (domScore < 30) domProgress = null;

            let nudgeSent = false;
            let nudgeCount = 0;
            if (probe) {
              const hasAnyProgressSignal = probeProgress !== null || domProgress !== null;
              probe.noProgressTicks = Number.isFinite(Number(probe.noProgressTicks)) ? Number(probe.noProgressTicks) : 0;
              probe.lastNudgeAt = Number.isFinite(Number(probe.lastNudgeAt)) ? Number(probe.lastNudgeAt) : 0;
              probe.nudgeCount = Number.isFinite(Number(probe.nudgeCount)) ? Number(probe.nudgeCount) : 0;
              if (hasAnyProgressSignal) {
                probe.noProgressTicks = 0;
              } else {
                probe.noProgressTicks += 1;
              }
              const nowNudge = Date.now();
              if (probe.noProgressTicks >= 3 && nowNudge - probe.lastNudgeAt >= 4500) {
                probe.lastNudgeAt = nowNudge;
                probe.noProgressTicks = 0;
                probe.nudgeCount += 1;
                nudgeCount = probe.nudgeCount;
                try {
                  window.dispatchEvent(new Event("focus"));
                  window.dispatchEvent(new Event("pageshow"));
                  document.dispatchEvent(new Event("visibilitychange"));
                } catch (error) {}
                nudgeSent = true;
              } else {
                nudgeCount = probe.nudgeCount;
              }
            }

            const actionNodes = queryAllDeep("button, [role='button']");
            const actionAllow = /(repeat|regenerate|retry|rerun|create video|generate video|crea video|genera video|ripeti|rigenera)/i;
            const actionDeny = /(cancel|close|dismiss|back|annulla|chiudi|indietro|stop)/i;
            let readyActionVisible = false;
            for (let i = 0; i < actionNodes.length; i += 1) {
              const node = actionNodes[i];
              if (!isVisible(node) || isDisabled(node)) continue;
              const text = String(
                [
                  node.getAttribute ? node.getAttribute("aria-label") || "" : "",
                  node.getAttribute ? node.getAttribute("title") || "" : "",
                  node.getAttribute ? node.getAttribute("data-tooltip") || "" : "",
                  node.getAttribute ? node.getAttribute("data-testid") || "" : "",
                  node.textContent || ""
                ]
                  .filter(Boolean)
                  .join(" ")
              );
              if (!text) continue;
              if (actionDeny.test(text)) continue;
              if (!actionAllow.test(text)) continue;
              readyActionVisible = true;
              break;
            }

            let videoUrl = probeVideoUrl;
            let videoPostId = probeVideoPostId;
            const videoNodes = queryAllDeep("video, source, a[href*='.mp4'], [data-url*='.mp4'], [src*='.mp4']");
            for (let i = 0; i < videoNodes.length; i += 1) {
              const node = videoNodes[i];
              const candidates = [];
              if (node instanceof HTMLVideoElement) {
                candidates.push(node.currentSrc || "", node.src || "");
              } else if (node instanceof HTMLSourceElement) {
                candidates.push(node.src || "");
              } else {
                candidates.push(
                  node.getAttribute ? node.getAttribute("href") || "" : "",
                  node.getAttribute ? node.getAttribute("src") || "" : "",
                  node.getAttribute ? node.getAttribute("data-url") || "" : ""
                );
              }
              for (let j = 0; j < candidates.length; j += 1) {
                const normalized = normalizeUrl(candidates[j]);
                if (!normalized) continue;
                if (!/\.mp4(\?|#|$)/i.test(normalized) && !/generated_video\.mp4/i.test(normalized)) continue;
                videoUrl = normalized;
                break;
              }
              if (videoUrl) break;
            }
            if (videoUrl) {
              const generatedMatch = videoUrl.match(/\/generated\/([0-9a-f-]{36})\/generated_video\.mp4/i);
              const shareMatch = videoUrl.match(/\/share-videos\/([0-9a-f-]{36})\.mp4/i);
              const genericMatch = videoUrl.match(/\/([0-9a-f-]{36})(?:\/[^/?#]+)?\.mp4(?:\?|#|$)/i);
              if (generatedMatch && generatedMatch[1]) {
                videoPostId = String(generatedMatch[1]);
              } else if (shareMatch && shareMatch[1]) {
                videoPostId = String(shareMatch[1]);
              } else if (genericMatch && genericMatch[1]) {
                videoPostId = String(genericMatch[1]);
              }
            }
            const sourceId = String(sourcePostId || "").trim().toLowerCase();
            const videoIdLower = String(videoPostId || "").trim().toLowerCase();
            const urlLower = String(videoUrl || "").trim().toLowerCase();
            const urlContainsSource = !!sourceId && !!urlLower && urlLower.includes(sourceId);
            const hasDifferentId = !!videoIdLower && !!sourceId && videoIdLower !== sourceId;
            const hasNewUrlSignal = !!urlLower && !!sourceId && !urlContainsSource;
            const isNewVideo = hasDifferentId || hasNewUrlSignal;

            return {
              progress: probeProgress !== null ? probeProgress : domProgress,
              probeProgress,
              domProgress,
              seq: probeSeq,
              moderated: probeModerated,
              status: probeStatus,
              requestSeen: probeRequestSeen,
              streamCount: probeStreamCount,
              thumbnailImageUrl: probeThumbnailImageUrl,
              parentPostId: probeParentPostId,
              videoUrl: isNewVideo ? videoUrl : "",
              videoPostId: isNewVideo ? videoPostId : "",
              isNewVideo,
              generationHintVisible,
              readyActionVisible,
              nudgeSent,
              nudgeCount
            };
          },
          args: [String(session.postId || ""), String(session.requestId || "")]
        },
        (results) => {
          session.progressProbeInFlight = false;
          if (chrome.runtime.lastError) return;
          const payload = results && results[0] ? results[0].result : null;
          const currentSession = nativeRegenSessions.get(session.requestId);
          if (!currentSession) return;
          if (!payload || typeof payload !== "object") return;

          const payloadStatus = Number(payload.status || 0);
          if ((payloadStatus === 403 || payloadStatus === 429) && Number(currentSession.lastProgress || 0) <= 1) {
            finishNativeRegenSession(currentSession.requestId, {
              type: "failed",
              status: payloadStatus,
              error: payloadStatus === 403 ? "cloudflare-or-auth-block" : "rate-limited"
            });
            return;
          }

          if (payload.moderated === true) {
            finishNativeRegenSession(currentSession.requestId, {
              type: "failed",
              status: 200,
              error: "moderated",
              moderated: true
            });
            return;
          }

          if (payload.videoUrl && payload.isNewVideo === true) {
            currentSession.lastProgress = 100;
            sendNativeRegenEvent(currentSession, {
              type: "stream",
              progress: 100,
              progressSource: payload.probeProgress !== null ? "stream" : "dom",
              videoPostId: payload.videoPostId ? String(payload.videoPostId) : "",
              videoUrl: String(payload.videoUrl),
              thumbnailImageUrl: payload.thumbnailImageUrl ? String(payload.thumbnailImageUrl) : "",
              parentPostId: payload.parentPostId ? String(payload.parentPostId) : ""
            });
            finishNativeRegenSession(currentSession.requestId, {
              type: "completed",
              status: 200,
              progress: 100,
              videoPostId: payload.videoPostId ? String(payload.videoPostId) : "",
              videoUrl: String(payload.videoUrl),
              thumbnailImageUrl: payload.thumbnailImageUrl ? String(payload.thumbnailImageUrl) : "",
              parentPostId: payload.parentPostId ? String(payload.parentPostId) : ""
            });
            return;
          }

          if (payload.seq && payload.seq > Number(currentSession.lastProbeSeq || 0)) {
            currentSession.lastProbeSeq = payload.seq;
          }
          const previousPct = Number(currentSession.lastProgress || 0);
          const progressSource = payload.probeProgress !== null ? "stream" : payload.domProgress !== null ? "dom" : "";
          const hasRawProgress = payload.progress !== null && payload.progress !== undefined;
          const rawPct = hasRawProgress ? Math.max(0, Math.min(100, Math.round(Number(payload.progress) || 0))) : 0;
          const noNetworkSignals =
            payload.requestSeen !== true &&
            Number(payload.streamCount || 0) <= 0 &&
            Number(payload.seq || 0) <= 0 &&
            payload.probeProgress === null;
          const suspiciousNearFinalJump =
            progressSource === "dom" &&
            payload.isNewVideo !== true &&
            rawPct >= 95 &&
            previousPct >= 10 &&
            previousPct < 90 &&
            rawPct - previousPct >= 30 &&
            noNetworkSignals;
          let effectivePct = rawPct;
          if (suspiciousNearFinalJump) {
            effectivePct = Math.min(94, previousPct + 8);
          }
          const nowMs = Date.now();
          if (NATIVE_REGEN_DIAG_ENABLED && nowMs - Number(currentSession.lastDiagSentAt || 0) >= 3500) {
            currentSession.lastDiagSentAt = nowMs;
            sendNativeRegenEvent(currentSession, {
              type: "diag",
              progressSource,
              prevProgress: previousPct,
              rawProgress: hasRawProgress ? rawPct : -1,
              effectiveProgress: hasRawProgress ? effectivePct : -1,
              hundredTicks: Number(currentSession.hundredTickCount || 0),
              highTicks: Number(currentSession.highProgressTickCount || 0),
              status: Number(payload.status || 0),
              requestSeen: payload.requestSeen === true,
              streamCount: Number(payload.streamCount || 0),
              seq: Number(payload.seq || 0),
              probeProgress: payload.probeProgress !== null && payload.probeProgress !== undefined ? Number(payload.probeProgress) : -1,
              domProgress: payload.domProgress !== null && payload.domProgress !== undefined ? Number(payload.domProgress) : -1,
              generationHintVisible: payload.generationHintVisible === true,
              readyActionVisible: payload.readyActionVisible === true,
              isNewVideo: payload.isNewVideo === true,
              nudgeSent: payload.nudgeSent === true,
              nudgeCount: Number(payload.nudgeCount || 0)
            });
          }
          if (!hasRawProgress) return;
          if (effectivePct >= 95) {
            currentSession.highProgressTickCount = Number(currentSession.highProgressTickCount || 0) + 1;
          } else {
            currentSession.highProgressTickCount = 0;
          }
          if (effectivePct >= 100) {
            currentSession.hundredTickCount = Number(currentSession.hundredTickCount || 0) + 1;
          } else {
            currentSession.hundredTickCount = 0;
          }
          const elapsedMs = Date.now() - Number(currentSession.startedAt || Date.now());
          const readyButtonCompletion =
            payload.isNewVideo !== true &&
            payload.readyActionVisible === true &&
            payload.generationHintVisible !== true &&
            effectivePct >= 95 &&
            Number(currentSession.highProgressTickCount || 0) >= 3 &&
            elapsedMs >= 18000 &&
            previousPct >= 45;
          if (readyButtonCompletion) {
            const fallbackVideoPostId = payload.videoPostId
              ? String(payload.videoPostId)
              : String(currentSession.postId || "");
            currentSession.lastProgress = 100;
            sendNativeRegenEvent(currentSession, {
              type: "stream",
              progress: 100,
              progressSource,
              moderated: payload.moderated === true,
              videoPostId: fallbackVideoPostId,
              videoUrl: payload.videoUrl ? String(payload.videoUrl) : "",
              thumbnailImageUrl: payload.thumbnailImageUrl ? String(payload.thumbnailImageUrl) : "",
              parentPostId: payload.parentPostId ? String(payload.parentPostId) : ""
            });
            finishNativeRegenSession(currentSession.requestId, {
              type: "completed",
              status: 200,
              progress: 100,
              videoPostId: fallbackVideoPostId,
              videoUrl: payload.videoUrl ? String(payload.videoUrl) : "",
              thumbnailImageUrl: payload.thumbnailImageUrl ? String(payload.thumbnailImageUrl) : "",
              parentPostId: payload.parentPostId ? String(payload.parentPostId) : ""
            });
            return;
          }
          const forceCompleteAt100 =
            payload.isNewVideo !== true &&
            effectivePct >= 100 &&
            Number(currentSession.hundredTickCount || 0) >= 4 &&
            elapsedMs >= 18000 &&
            previousPct >= 85;
          if (forceCompleteAt100) {
            const fallbackVideoPostId = payload.videoPostId
              ? String(payload.videoPostId)
              : String(currentSession.postId || "");
            currentSession.lastProgress = 100;
            sendNativeRegenEvent(currentSession, {
              type: "stream",
              progress: 100,
              progressSource: payload.probeProgress !== null ? "stream" : payload.domProgress !== null ? "dom" : "",
              moderated: payload.moderated === true,
              videoPostId: fallbackVideoPostId,
              videoUrl: payload.videoUrl ? String(payload.videoUrl) : "",
              thumbnailImageUrl: payload.thumbnailImageUrl ? String(payload.thumbnailImageUrl) : "",
              parentPostId: payload.parentPostId ? String(payload.parentPostId) : ""
            });
            finishNativeRegenSession(currentSession.requestId, {
              type: "completed",
              status: 200,
              progress: 100,
              videoPostId: fallbackVideoPostId,
              videoUrl: payload.videoUrl ? String(payload.videoUrl) : "",
              thumbnailImageUrl: payload.thumbnailImageUrl ? String(payload.thumbnailImageUrl) : "",
              parentPostId: payload.parentPostId ? String(payload.parentPostId) : ""
            });
            return;
          }
          let pct = effectivePct;
          if (pct >= 100 && payload.isNewVideo !== true) pct = 99;
          if (pct <= previousPct) return;
          currentSession.lastProgress = pct;
          sendNativeRegenEvent(currentSession, {
            type: "stream",
            progress: pct,
            progressSource,
            moderated: payload.moderated === true,
            videoPostId: payload.videoPostId ? String(payload.videoPostId) : "",
            videoUrl: payload.videoUrl ? String(payload.videoUrl) : "",
            thumbnailImageUrl: payload.thumbnailImageUrl ? String(payload.thumbnailImageUrl) : "",
            parentPostId: payload.parentPostId ? String(payload.parentPostId) : ""
          });
        }
      );
    }, 900);
  };

  const clickNativeRepeatButton = (tabId, requestToken) =>
    new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          world: "MAIN",
          func: async (tokenArg) => {
            const sleep = (ms) =>
              new Promise((next) => {
                setTimeout(next, ms);
              });
            const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
            const lower = (value) => normalize(value).toLowerCase();
            const isVisible = (node) => {
              if (!node || !(node instanceof Element)) return false;
              const rect = node.getBoundingClientRect();
              if (!rect || rect.width <= 0 || rect.height <= 0) return false;
              const style = window.getComputedStyle(node);
              if (!style) return false;
              if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) return false;
              return true;
            };
            const isDisabled = (node) => {
              if (!node) return true;
              if (node.disabled) return true;
              const ariaDisabled = String(node.getAttribute && node.getAttribute("aria-disabled") ? node.getAttribute("aria-disabled") : "");
              if (ariaDisabled.toLowerCase() === "true") return true;
              return false;
            };
            const elementText = (node) =>
              lower(
                [
                  node && node.getAttribute ? node.getAttribute("aria-label") : "",
                  node && node.getAttribute ? node.getAttribute("title") : "",
                  node && node.getAttribute ? node.getAttribute("data-tooltip") : "",
                  node && node.textContent ? node.textContent : ""
                ]
                  .filter(Boolean)
                  .join(" ")
              );
            const repeatKeywords = ["repeat", "regenerate", "retry", "rerun", "rigenera", "ripeti"];
            const createStartKeywords = [
              "create video",
              "generate video",
              "create",
              "generate",
              "crea video",
              "genera video",
              "crea",
              "genera"
            ];
            const confirmKeywords = [
              "create video",
              "generate video",
              "create",
              "generate",
              "repeat",
              "rerun",
              "crea video",
              "genera",
              "ripeti",
              "continue",
              "submit"
            ];
            const rejectKeywords = ["cancel", "close", "annulla", "chiudi", "back", "indietro", "dismiss"];
            const primaryHintKeywords = ["primary", "submit", "confirm", "action", "cta"];
            const generationStateKeywords = ["generating", "queued", "rendering", "processing", "in progress", "stop"];
            const clamp = (value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
            const tokenText = String(tokenArg || "").trim();
            if (tokenText) {
              try {
                window.__grokViewerNativeActiveToken = tokenText;
              } catch (error) {}
            }
            const getActiveToken = () => {
              try {
                const currentToken = String(window.__grokViewerNativeActiveToken || "").trim();
                if (currentToken) return currentToken;
              } catch (error) {}
              return tokenText;
            };
            const normalizeUrl = (url) => {
              const raw = String(url || "").trim();
              if (!raw) return "";
              if (raw.startsWith("blob:")) return "";
              if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
              if (raw.startsWith("//")) return `${window.location.protocol}${raw}`;
              if (raw.startsWith("users/") || raw.startsWith("/users/")) return `https://assets.grok.com/${raw.replace(/^\/+/, "")}`;
              if (raw.startsWith("/imagine-public/")) return `https://imagine-public.x.ai${raw}`;
              if (raw.startsWith("imagine-public/")) return `https://imagine-public.x.ai/${raw}`;
              try {
                return new URL(raw, window.location.origin).toString();
              } catch (error) {
                return raw;
              }
            };
            const ensureProbe = () => {
              const activeToken = getActiveToken();
              const current = window.__grokViewerNativeRegenProbe;
              if (!current || typeof current !== "object" || String(current.token || "").trim() !== activeToken) {
                window.__grokViewerNativeRegenProbe = {
                  token: activeToken,
                  seq: 0,
                  progress: null,
                  moderated: false,
                  requestSeen: false,
                  streamCount: 0,
                  videoPostId: "",
                  videoUrl: "",
                  thumbnailImageUrl: "",
                  parentPostId: "",
                  httpStatus: 0,
                  lastEventAt: Date.now()
                };
              }
              return window.__grokViewerNativeRegenProbe;
            };
            const bumpProbe = () => {
              const probe = ensureProbe();
              probe.seq = Number.isFinite(Number(probe.seq)) ? Number(probe.seq) + 1 : 1;
              probe.lastEventAt = Date.now();
              return probe;
            };
            const applyStreamToProbe = (stream) => {
              if (!stream || typeof stream !== "object") return;
              const probe = ensureProbe();
              let changed = false;
              const progress = Number(stream.progress);
              if (Number.isFinite(progress)) {
                const pct = clamp(progress);
                if (probe.progress !== pct) {
                  probe.progress = pct;
                  changed = true;
                }
              }
              if (stream.moderated === true && probe.moderated !== true) {
                probe.moderated = true;
                changed = true;
              }
              if (stream.videoPostId) {
                const id = String(stream.videoPostId);
                if (probe.videoPostId !== id) {
                  probe.videoPostId = id;
                  changed = true;
                }
              }
              if (stream.videoUrl) {
                const normalized = normalizeUrl(stream.videoUrl);
                if (normalized && probe.videoUrl !== normalized) {
                  probe.videoUrl = normalized;
                  changed = true;
                }
              }
              if (stream.thumbnailImageUrl) {
                const normalized = normalizeUrl(stream.thumbnailImageUrl);
                if (normalized && probe.thumbnailImageUrl !== normalized) {
                  probe.thumbnailImageUrl = normalized;
                  changed = true;
                }
              }
              if (stream.parentPostId) {
                const parent = String(stream.parentPostId);
                if (probe.parentPostId !== parent) {
                  probe.parentPostId = parent;
                  changed = true;
                }
              }
              if (changed) bumpProbe();
            };
            const parseStreamLine = (line) => {
              const text = String(line || "").trim();
              if (!text) return;
              const probe = ensureProbe();
              probe.streamCount = Number.isFinite(Number(probe.streamCount)) ? Number(probe.streamCount) + 1 : 1;
              let parsed = null;
              try {
                parsed = JSON.parse(text);
              } catch (error) {
                parsed = null;
              }
              if (!parsed || typeof parsed !== "object") return;
              const responseNode = parsed && parsed.result && parsed.result.response ? parsed.result.response : null;
              if (!responseNode || typeof responseNode !== "object") return;
              applyStreamToProbe(responseNode.streamingVideoGenerationResponse);
            };
            const parseStreamText = (text) => {
              const lines = String(text || "").split(/\r?\n/);
              for (let i = 0; i < lines.length; i += 1) parseStreamLine(lines[i]);
            };
            const consumeConversationResponse = async (response) => {
              const probe = ensureProbe();
              probe.httpStatus = Number(response && response.status ? response.status : 0);
              probe.lastEventAt = Date.now();
              if (!response || !response.ok) return;
              if (response.body && typeof response.body.getReader === "function") {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                while (true) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  buffer += decoder.decode(chunk.value, { stream: true });
                  let newline = buffer.indexOf("\n");
                  while (newline >= 0) {
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + 1);
                    if (line) parseStreamLine(line);
                    newline = buffer.indexOf("\n");
                  }
                }
                buffer += decoder.decode();
                const tail = buffer.trim();
                if (tail) parseStreamLine(tail);
                return;
              }
              try {
                const text = await response.text();
                parseStreamText(text);
              } catch (error) {}
            };

            const seenRoots = new Set();
            const collectRoots = () => {
              const roots = [document];
              seenRoots.clear();
              seenRoots.add(document);
              const queue = [document.documentElement];
              while (queue.length) {
                const el = queue.shift();
                if (!el || !(el instanceof Element)) continue;
                if (el.shadowRoot && !seenRoots.has(el.shadowRoot)) {
                  seenRoots.add(el.shadowRoot);
                  roots.push(el.shadowRoot);
                  const nested = el.shadowRoot.querySelectorAll("*");
                  for (let i = 0; i < nested.length; i += 1) queue.push(nested[i]);
                }
                const children = el.children || [];
                for (let i = 0; i < children.length; i += 1) queue.push(children[i]);
              }
              return roots;
            };

            const queryAllDeep = (selector) => {
              const roots = collectRoots();
              const out = [];
              for (let i = 0; i < roots.length; i += 1) {
                const root = roots[i];
                let nodes = [];
                try {
                  nodes = Array.from(root.querySelectorAll(selector));
                } catch (error) {
                  nodes = [];
                }
                for (let j = 0; j < nodes.length; j += 1) out.push(nodes[j]);
              }
              return out;
            };

            const uniqueElements = (nodes) => {
              const set = new Set();
              const out = [];
              for (let i = 0; i < nodes.length; i += 1) {
                const node = nodes[i];
                if (!node || !(node instanceof Element)) continue;
                if (set.has(node)) continue;
                set.add(node);
                out.push(node);
              }
              return out;
            };

            const scoreRepeatNode = (node) => {
              if (!node || isDisabled(node) || !isVisible(node)) return 0;
              const text = elementText(node);
              if (!text) return 0;
              for (let i = 0; i < rejectKeywords.length; i += 1) {
                if (text.includes(rejectKeywords[i])) return 0;
              }
              const marker = lower(
                [
                  node.className || "",
                  node.id || "",
                  node.getAttribute ? node.getAttribute("data-testid") || "" : "",
                  node.getAttribute ? node.getAttribute("name") || "" : ""
                ].join(" ")
              );
              const hasRepeat = repeatKeywords.some((key) => text.includes(key) || marker.includes(key));
              const hasCreate = createStartKeywords.some((key) => text.includes(key) || marker.includes(key));
              if (!hasRepeat && !hasCreate) return 0;
              let score = 0;
              for (let i = 0; i < repeatKeywords.length; i += 1) {
                if (text.includes(repeatKeywords[i]) || marker.includes(repeatKeywords[i])) score += 12;
              }
              for (let i = 0; i < createStartKeywords.length; i += 1) {
                if (text.includes(createStartKeywords[i]) || marker.includes(createStartKeywords[i])) score += 8;
              }
              if (text.includes("video") || marker.includes("video")) score += 6;
              if (!hasRepeat && !(text.includes("video") || marker.includes("video"))) score -= 6;
              if (text.includes("prompt")) score += 1;
              return score > 0 ? score : 0;
            };

            const scoreConfirmNode = (node) => {
              if (!node || isDisabled(node) || !isVisible(node)) return 0;
              const text = elementText(node);
              if (!text) return 0;
              for (let i = 0; i < rejectKeywords.length; i += 1) {
                if (text.includes(rejectKeywords[i])) return 0;
              }
              let score = 0;
              for (let i = 0; i < confirmKeywords.length; i += 1) {
                if (text.includes(confirmKeywords[i])) score += 10;
              }
              const marker = lower(
                [
                  node.className || "",
                  node.id || "",
                  node.getAttribute ? node.getAttribute("data-testid") || "" : "",
                  node.getAttribute ? node.getAttribute("type") || "" : ""
                ].join(" ")
              );
              for (let i = 0; i < primaryHintKeywords.length; i += 1) {
                if (marker.includes(primaryHintKeywords[i])) score += 3;
              }
              if (marker.includes("submit")) score += 5;
              if (text.includes("video")) score += 3;
              return score;
            };

            const collectRepeatCandidates = () => {
              const directSelectors = [
                'button[aria-label*="repeat" i]',
                'button[aria-label*="regenerate" i]',
                'button[aria-label*="create video" i]',
                'button[aria-label*="generate video" i]',
                'button[aria-label*="crea video" i]',
                'button[aria-label*="genera video" i]',
                'button[title*="repeat" i]',
                'button[title*="regenerate" i]',
                'button[title*="create video" i]',
                'button[title*="generate video" i]',
                'button[title*="crea video" i]',
                'button[title*="genera video" i]',
                '[role="button"][aria-label*="repeat" i]',
                '[role="button"][aria-label*="regenerate" i]',
                '[role="button"][aria-label*="create video" i]',
                '[role="button"][aria-label*="generate video" i]',
                '[role="button"][aria-label*="crea video" i]',
                '[role="button"][aria-label*="genera video" i]',
                '[data-tooltip*="repeat" i]',
                '[data-tooltip*="regenerate" i]',
                '[data-tooltip*="create video" i]',
                '[data-tooltip*="generate video" i]',
                '[data-tooltip*="crea video" i]',
                '[data-tooltip*="genera video" i]',
                '[data-testid*="repeat" i]',
                '[data-testid*="regenerate" i]',
                '[data-testid*="create-video" i]',
                '[data-testid*="generate-video" i]'
              ];
              const pool = [];
              for (let i = 0; i < directSelectors.length; i += 1) {
                pool.push(...queryAllDeep(directSelectors[i]));
              }
              pool.push(...queryAllDeep('button, [role="button"], a[role="button"]'));
              const nodes = uniqueElements(pool);
              const scored = [];
              for (let i = 0; i < nodes.length; i += 1) {
                const node = nodes[i];
                const score = scoreRepeatNode(node);
                if (score <= 0) continue;
                scored.push({ node, score, text: elementText(node) });
              }
              scored.sort((a, b) => b.score - a.score);
              return scored.slice(0, 12);
            };

            const collectDialogRoots = () => {
              const roots = uniqueElements(
                queryAllDeep('[role="dialog"], [aria-modal="true"], [data-state="open"], .modal, .dialog, [class*="modal"], [class*="dialog"]')
              ).filter((node) => isVisible(node));
              return roots;
            };

            const findConfirmCandidate = () => {
              const dialogRoots = collectDialogRoots();
              let best = null;
              let bestScore = 0;
              for (let d = 0; d < dialogRoots.length; d += 1) {
                const root = dialogRoots[d];
                const pool = uniqueElements([
                  ...Array.from(root.querySelectorAll('button[type="submit"], button, [role="button"], a[role="button"]')),
                  ...Array.from(root.querySelectorAll('[data-testid*="submit" i], [class*="primary" i], [data-variant*="primary" i]'))
                ]);
                for (let i = 0; i < pool.length; i += 1) {
                  const node = pool[i];
                  const score = scoreConfirmNode(node);
                  if (score > bestScore) {
                    best = node;
                    bestScore = score;
                  }
                }
              }
              return bestScore > 0 ? best : null;
            };

            const clickNode = (node) => {
              if (!node) return false;
              try {
                node.scrollIntoView({ block: "center", inline: "center" });
              } catch (error) {}
              const isNativeClickable =
                node instanceof HTMLButtonElement ||
                node instanceof HTMLAnchorElement ||
                node instanceof HTMLInputElement;
              if (isNativeClickable && typeof node.click === "function") {
                try {
                  node.click();
                  return true;
                } catch (error) {}
              }
              const eventInit = { bubbles: true, cancelable: true, composed: true, view: window };
              try {
                node.dispatchEvent(new MouseEvent("click", eventInit));
                return true;
              } catch (error) {}
              return false;
            };

            const bodyLooksBlocked = () => {
              const bodyText = lower(document.body && document.body.textContent ? document.body.textContent : "");
              return bodyText.includes("just a moment") && bodyText.includes("enable javascript and cookies");
            };

            const bodyLooksGenerating = () => {
              const text = lower(document.body && document.body.textContent ? document.body.textContent : "");
              for (let i = 0; i < generationStateKeywords.length; i += 1) {
                if (text.includes(generationStateKeywords[i])) return true;
              }
              return false;
            };

            let conversationRequestSeen = false;
            ensureProbe();
              if (typeof window.fetch === "function" && window.__grokViewerNativeFetchSpyInstalled !== true) {
                const originalFetch = window.fetch;
                window.__grokViewerNativeFetchSpyInstalled = true;
                window.fetch = function fetchSpy() {
                  let isConversationRequest = false;
                  try {
                    const input = arguments[0];
                    const url =
                      input && typeof input === "object" && input.url
                        ? String(input.url)
                        : String(input || "");
                    if (url.includes("/rest/app-chat/conversations/new")) {
                      conversationRequestSeen = true;
                      isConversationRequest = true;
                      const probe = ensureProbe();
                      if (probe.requestSeen !== true) {
                        probe.requestSeen = true;
                        bumpProbe();
                      }
                    }
                  } catch (error) {}
                  const responsePromise = originalFetch.apply(this, arguments);
                  if (isConversationRequest) {
                    Promise.resolve(responsePromise)
                      .then((response) => {
                        if (!response) return;
                        try {
                          const clone = response.clone();
                          consumeConversationResponse(clone).catch(() => {});
                        } catch (error) {
                          consumeConversationResponse(response).catch(() => {});
                        }
                      })
                      .catch(() => {});
                  }
                  return responsePromise;
                };
              }

              if (window.XMLHttpRequest && window.XMLHttpRequest.prototype && window.__grokViewerNativeXhrSpyInstalled !== true) {
                const proto = window.XMLHttpRequest.prototype;
                const originalOpen = proto.open;
                const originalSend = proto.send;
                window.__grokViewerNativeXhrSpyInstalled = true;
                proto.open = function openSpy(method, url) {
                  this.__grokViewerXhrUrl = String(url || "");
                  return originalOpen.apply(this, arguments);
                };
                proto.send = function sendSpy() {
                  try {
                    const url = String(this.__grokViewerXhrUrl || "");
                    if (url.includes("/rest/app-chat/conversations/new")) {
                      conversationRequestSeen = true;
                      const probe = ensureProbe();
                      if (probe.requestSeen !== true) {
                        probe.requestSeen = true;
                        bumpProbe();
                      }
                      this.addEventListener(
                        "load",
                        () => {
                          try {
                            const probe = ensureProbe();
                            probe.httpStatus = Number(this.status || 0);
                            probe.lastEventAt = Date.now();
                            if (Number(this.status || 0) >= 200 && Number(this.status || 0) < 300) {
                              parseStreamText(String(this.responseText || ""));
                            }
                          } catch (error) {}
                        },
                        { once: true }
                      );
                    }
                  } catch (error) {}
                  return originalSend.apply(this, arguments);
                };
              }

              let repeatCandidates = [];
              for (let wait = 0; wait < 120; wait += 1) {
                if (bodyLooksBlocked()) {
                  return { ok: false, error: "cloudflare-challenge-page" };
                }
                repeatCandidates = collectRepeatCandidates();
                if (repeatCandidates.length) break;
                await sleep(150);
              }
              if (!repeatCandidates.length) {
                return { ok: false, error: "start-button-not-found" };
              }

              const hasGenerationStartSignal = (node, beforeDisabled) => {
                if (conversationRequestSeen) return true;
                const probe = ensureProbe();
                if (probe.requestSeen === true) {
                  conversationRequestSeen = true;
                  return true;
                }
                const probeProgress = Number(probe.progress);
                if (Number.isFinite(probeProgress) && probeProgress >= 0) return true;
                const streamCount = Number(probe.streamCount);
                if (Number.isFinite(streamCount) && streamCount > 0) return true;
                const seq = Number(probe.seq);
                if (Number.isFinite(seq) && seq > 0) return true;
                if (!beforeDisabled && isDisabled(node)) return true;
                if (bodyLooksGenerating()) return true;
                return false;
              };

              const maxCandidates = Math.min(repeatCandidates.length, 3);
              for (let i = 0; i < maxCandidates; i += 1) {
                const entry = repeatCandidates[i];
                const node = entry.node;
                const label = normalize(node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent);
                const beforeDisabled = isDisabled(node);
                if (!clickNode(node)) continue;

                let confirmClicked = false;
                let confirmLabel = "";
                for (let t = 0; t < 96; t += 1) {
                  if (bodyLooksBlocked()) {
                    return { ok: false, error: "cloudflare-challenge-page" };
                  }
                  if (!confirmClicked) {
                    const confirm = findConfirmCandidate();
                    if (confirm) {
                      confirmLabel = normalize(confirm.getAttribute("aria-label") || confirm.getAttribute("title") || confirm.textContent);
                      clickNode(confirm);
                      confirmClicked = true;
                      await sleep(120);
                      continue;
                    }
                  }
                  if (hasGenerationStartSignal(node, beforeDisabled)) {
                    return {
                      ok: true,
                      label: label || "repeat",
                      confirmed: confirmClicked,
                      confirmLabel: confirmClicked ? confirmLabel || "create video" : ""
                    };
                  }
                  await sleep(140);
                }
                if (confirmClicked) {
                  return { ok: false, error: "repeat-clicked-but-not-triggered" };
                }
              }

              return { ok: false, error: "repeat-clicked-but-not-triggered" };
          },
          args: [String(requestToken || "")]
        },
        (results) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || "native-repeat-click-failed"));
            return;
          }
          const payload = results && results[0] ? results[0].result : null;
          resolve(payload || { ok: false, error: "no-click-result" });
        }
      );
    });

  chrome.tabs.onRemoved.addListener((tabId) => {
    const requestId = nativeRegenByTargetTab.get(tabId);
    if (!requestId) return;
    finishNativeRegenSession(requestId, {
      type: "failed",
      error: "target-tab-closed"
    });
  });

  chrome.action.onClicked.addListener((tab) => {
    openViewerWindow(tab && tab.incognito);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.action === "openViewerWindow") {
      openViewerWindow(sender && sender.tab && sender.tab.incognito);
      sendResponse({ ok: true });
      return true;
    }

    if (message && message.action === "grokViewerFetchBinary") {
      const rawUrl = String(message.url || "").trim();
      if (!rawUrl) {
        sendResponse({ ok: false, error: "no-url" });
        return true;
      }
      let targetUrl = rawUrl;
      try {
        targetUrl = new URL(rawUrl).toString();
      } catch (error) {}
      const timeoutMs = Math.max(3000, Math.min(180000, Number(message.timeoutMs) || 60000));
      const isPublic = /imagine-public\.x\.ai/i.test(targetUrl);
      const deadline = Date.now() + timeoutMs;
      const credentialsModes = isPublic ? ["omit", "include"] : ["include", "omit"];
      const buildFetchTargetUrls = (url) => {
        const variants = [];
        const push = (value) => {
          const normalized = String(value || "").trim();
          if (!normalized || variants.includes(normalized)) return;
          variants.push(normalized);
        };
        push(url);
        try {
          const parsed = new URL(url);
          const pathname = String(parsed.pathname || "").toLowerCase();
          const isMp4 = pathname.endsWith(".mp4") || pathname.includes("generated_video.mp4");
          if (isMp4 && !parsed.searchParams.has("cache")) {
            parsed.searchParams.set("cache", "1");
            push(parsed.toString());
          }
        } catch (error) {}
        return variants;
      };

      const arrayBufferToBase64 = (buffer) => {
        try {
          const bytes = new Uint8Array(buffer || new ArrayBuffer(0));
          let binary = "";
          const chunkSize = 0x8000;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, chunk);
          }
          return btoa(binary);
        } catch (error) {
          return "";
        }
      };

      const attemptFetch = async (fetchUrl, credentialsMode) => {
        const timeLeft = Math.max(1000, deadline - Date.now());
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeLeft);
        try {
          const response = await fetch(fetchUrl, {
            credentials: credentialsMode,
            signal: controller.signal,
            cache: "no-store"
          });
          if (!response || !response.ok) {
            return {
              ok: false,
              status: Number((response && response.status) || 0),
              error: `HTTP ${Number((response && response.status) || 0)}`
            };
          }
          const buffer = await response.arrayBuffer();
          const base64 = arrayBufferToBase64(buffer);
          if (!base64) {
            return {
              ok: false,
              status: Number(response.status || 200),
              error: "binary-encode-failed"
            };
          }
          return {
            ok: true,
            status: Number(response.status || 200),
            contentType: response.headers.get("content-type") || "",
            base64
          };
        } catch (error) {
          return { ok: false, error: String((error && error.message) || error || "fetch-failed") };
        } finally {
          clearTimeout(timer);
        }
      };

      (async () => {
        let lastResult = null;
        for (let i = 0; i < credentialsModes.length; i += 1) {
          const mode = credentialsModes[i];
          const targets = buildFetchTargetUrls(targetUrl);
          for (let t = 0; t < targets.length; t += 1) {
            const result = await attemptFetch(targets[t], mode);
            lastResult = result;
            if (result && result.ok) {
              sendResponse(result);
              return;
            }
            const statusCode = Number((result && result.status) || 0);
            if (statusCode && statusCode !== 401 && statusCode !== 403) break;
            if (Date.now() >= deadline) break;
          }
          const statusCode = Number((lastResult && lastResult.status) || 0);
          if (statusCode && statusCode !== 401 && statusCode !== 403) break;
          if (Date.now() >= deadline) break;
        }
        sendResponse(lastResult || { ok: false, error: "fetch-failed" });
      })();
      return true;
    }

    if (message && message.action === "grokViewerDownloadUrl") {
      const url = message.postUrl || message.url;
      const requestedFilename = message.filename;
      const requestedSaveAs = message.saveAs === true;
      const requestedMode = message.mode;
      const requestedFolderPath = sanitizeFolderPath(message.folderPath || "");
      if (!url) {
        sendResponse({ ok: false, error: "no-url" });
        return true;
      }
      chrome.storage.local.get(SETTINGS_KEY, (data) => {
        const settings = data && data[SETTINGS_KEY] ? data[SETTINGS_KEY] : {};
        const storedMode = settings && settings.downloadMode ? settings.downloadMode : "ask_each";
        const mode =
          requestedMode === "folder_once" || requestedMode === "ask_each" || requestedMode === "default_auto"
            ? requestedMode
            : storedMode;
        const folderPath = requestedFolderPath || sanitizeFolderPath(settings && settings.folderPath ? settings.folderPath : "");
        let saveAs = requestedSaveAs;
        let filename = requestedFilename || "";
        if (mode === "folder_once") {
          saveAs = false;
          const cleanFilename = filename.replace(/^\/+/, "");
          if (cleanFilename && folderPath && !cleanFilename.startsWith(`${folderPath}/`) && !cleanFilename.includes("/")) {
            filename = `${folderPath}/${cleanFilename}`;
          }
        } else if (mode === "default_auto") {
          saveAs = false;
        }
        const options = { url, saveAs, conflictAction: "uniquify" };
        if (filename) options.filename = filename;
        chrome.downloads.download(options, (downloadId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          sendResponse({ ok: true, downloadId });
        });
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

    if (message && message.action === "grokViewerSequenceGenerate") {
      (async () => {
        try {
          const payload = message && message.payload ? message.payload : null;
          if (!payload || !payload.imageDataUrl) {
            sendResponse({ ok: false, error: "missing-sequence-payload" });
            return;
          }
          const targetTab = await ensureImagineTargetTab();
          let lastResult = { ok: false, error: "sequence-message-failed" };
          for (let attempt = 0; attempt < 3; attempt += 1) {
            if (attempt > 0) {
              await new Promise((resolve) => setTimeout(resolve, 320));
            }
            const result = await sendMessageToTab(targetTab.id, {
              action: "grokViewerSequenceGenerateFromImage",
              payload
            });
            lastResult = result;
            if (result && result.ok) break;
            const errText = String((result && result.error) || "").toLowerCase();
            if (errText.includes("receiving end does not exist")) {
              await waitForTabComplete(targetTab.id, 10000).catch(() => {});
              continue;
            }
            if (!errText.includes("tab-no-response")) break;
          }
          sendResponse(lastResult && lastResult.ok ? { ok: true } : { ok: false, error: (lastResult && lastResult.error) || "sequence-failed" });
        } catch (error) {
          sendResponse({ ok: false, error: (error && error.message) || "sequence-failed" });
        }
      })();
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

    if (message && message.action === "grokViewerRegenViaNativeTab") {
      const viewerTabId = sender && sender.tab ? sender.tab.id : null;
      const requestId = String((message && message.requestId) || "").trim();
      const postId = String((message && message.postId) || "").trim();
      if (!viewerTabId || !requestId || !postId) {
        sendResponse({ ok: false, error: "missing-viewer-request-or-post" });
        return true;
      }

      if (nativeRegenSessions.has(requestId)) {
        clearNativeRegenSession(requestId);
      }

      const postUrl = `https://grok.com/imagine/post/${postId}`;
      let responded = false;
      const safeRespond = (payload) => {
        if (responded) return;
        responded = true;
        sendResponse(payload || { ok: false, error: "unknown-native-regen-error" });
      };

      createNativeRegenTab(postUrl)
        .then(async (created) => {
          const targetTabId = created.tabId;
          const session = {
            requestId,
            viewerTabId,
            targetTabId,
            postId,
            postUrl,
            hiddenWindowId: created.hiddenWindowId || null,
            startedAt: Date.now(),
            timeoutId: null,
            progressPollId: null,
            progressProbeInFlight: false,
            lastProgress: 1,
            syntheticTicks: 0,
            lastProbeSeq: 0,
            hundredTickCount: 0,
            highProgressTickCount: 0,
            lastDiagSentAt: 0
          };
          nativeRegenSessions.set(requestId, session);
          nativeRegenByTargetTab.set(targetTabId, requestId);
          sendNativeRegenEvent(session, { type: "opened", targetTabId, postUrl });
          safeRespond({ ok: true, targetTabId, postUrl });

          try {
            await waitForTabComplete(targetTabId, 45000);
            const clickResult = await clickNativeRepeatButton(targetTabId, requestId);
            if (!clickResult || clickResult.ok !== true) {
              const errorText = String((clickResult && clickResult.error) || "native-repeat-click-failed");
              finishNativeRegenSession(requestId, {
                type: "failed",
                error: errorText,
                status: errorText.includes("cloudflare") ? 403 : 0,
                challengeDetected: errorText.includes("cloudflare")
              });
              return;
            }

            sendNativeRegenEvent(session, {
              type: "clicked",
              targetTabId,
              label: clickResult.label || "repeat",
              confirmed: clickResult.confirmed === true,
              confirmLabel: clickResult.confirmLabel ? String(clickResult.confirmLabel) : ""
            });

            startNativeRegenProgressPolling(session);
            session.timeoutId = setTimeout(() => {
              finishNativeRegenSession(requestId, {
                type: "failed",
                error: "native-regen-timeout",
                status: 0
              });
            }, 4 * 60 * 1000);
          } catch (error) {
            const errText = String((error && error.message) || error || "native-regen-start-failed");
            finishNativeRegenSession(requestId, {
              type: "failed",
              error: errText,
              status: 0
            });
          }
        })
        .catch((error) => {
          safeRespond({ ok: false, error: (error && error.message) || "tab-create-failed" });
        });
      return true;
    }

    if (message && message.action === "grokViewerRegenAbortNativeTab") {
      const requestId = String((message && message.requestId) || "").trim();
      if (requestId && nativeRegenSessions.has(requestId)) {
        finishNativeRegenSession(requestId, { type: "aborted" });
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message && message.action === "grokViewerRegenForceCompleteNativeTab") {
      const requestId = String((message && message.requestId) || "").trim();
      const session = requestId ? nativeRegenSessions.get(requestId) : null;
      if (!session) {
        sendResponse({ ok: false, error: "native-session-not-found" });
        return true;
      }
      const videoPostId = String((message && message.videoPostId) || "").trim();
      const videoUrl = String((message && message.videoUrl) || "").trim();
      const thumbnailImageUrl = String((message && message.thumbnailImageUrl) || "").trim();
      const parentPostId = String((message && message.parentPostId) || "").trim();
      finishNativeRegenSession(requestId, {
        type: "completed",
        status: 200,
        progress: 100,
        videoPostId: videoPostId || String(session.postId || ""),
        videoUrl,
        thumbnailImageUrl,
        parentPostId
      });
      sendResponse({ ok: true });
      return true;
    }

    if (message && message.action === "grokViewerRegenPageEvent") {
      const sourceTabId = sender && sender.tab ? sender.tab.id : null;
      if (!sourceTabId) {
        sendResponse({ ok: false, error: "missing-source-tab" });
        return true;
      }
      const requestId = nativeRegenByTargetTab.get(sourceTabId);
      if (!requestId) {
        sendResponse({ ok: true, ignored: true });
        return true;
      }
      const session = nativeRegenSessions.get(requestId);
      if (!session) {
        nativeRegenByTargetTab.delete(sourceTabId);
        sendResponse({ ok: true, ignored: true });
        return true;
      }
      const eventType = String((message && message.eventType) || "").trim();
      const data = message && message.data && typeof message.data === "object" ? message.data : {};

      if (eventType === "regenHttp") {
        const statusCode = Number(data.status || 0);
        sendNativeRegenEvent(session, {
          type: "http",
          status: statusCode,
          challengeDetected: data.challengeDetected === true,
          errorHint: data.errorHint ? String(data.errorHint) : "",
          pageUrl: data.pageUrl ? String(data.pageUrl) : "",
          tabId: sourceTabId
        });
        if (statusCode === 403 || statusCode === 429) {
          finishNativeRegenSession(requestId, {
            type: "failed",
            status: statusCode,
            challengeDetected: data.challengeDetected === true,
            errorHint: data.errorHint ? String(data.errorHint) : "",
            error: statusCode === 403 ? "cloudflare-or-auth-block" : "rate-limited"
          });
        }
        sendResponse({ ok: true });
        return true;
      }

      if (eventType === "regenQuery") {
        sendNativeRegenEvent(session, {
          type: "query",
          queryType: data.queryType ? String(data.queryType) : ""
        });
        sendResponse({ ok: true });
        return true;
      }

      if (eventType === "regenStream") {
        const progress = Number(data.progress);
        const normalizedProgress = Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : null;
        const streamPayload = {
          type: "stream",
          progress: normalizedProgress,
          moderated: data.moderated === true,
          videoPostId: data.videoPostId ? String(data.videoPostId) : "",
          videoUrl: data.videoUrl ? String(data.videoUrl) : "",
          thumbnailImageUrl: data.thumbnailImageUrl ? String(data.thumbnailImageUrl) : "",
          parentPostId: data.parentPostId ? String(data.parentPostId) : ""
        };
        if (normalizedProgress !== null) {
          session.lastProgress = Math.max(Number(session.lastProgress || 0), normalizedProgress);
          session.syntheticTicks = 0;
        }
        sendNativeRegenEvent(session, streamPayload);
        if (streamPayload.moderated) {
          finishNativeRegenSession(requestId, {
            type: "failed",
            status: 200,
            error: "moderated",
            moderated: true
          });
          sendResponse({ ok: true });
          return true;
        }
        const hasFinalSignal =
          !!streamPayload.videoUrl ||
          (normalizedProgress !== null && normalizedProgress >= 100 && !!streamPayload.videoPostId);
        if (hasFinalSignal) {
          finishNativeRegenSession(requestId, {
            type: "completed",
            status: 200,
            videoPostId: streamPayload.videoPostId,
            videoUrl: streamPayload.videoUrl,
            thumbnailImageUrl: streamPayload.thumbnailImageUrl,
            parentPostId: streamPayload.parentPostId
          });
        }
        sendResponse({ ok: true });
        return true;
      }

      if (eventType === "videoUrl") {
        const videoUrl = data.url ? String(data.url) : "";
        if (videoUrl) {
          finishNativeRegenSession(requestId, {
            type: "completed",
            status: 200,
            videoPostId: "",
            videoUrl,
            thumbnailImageUrl: "",
            parentPostId: ""
          });
        }
        sendResponse({ ok: true });
        return true;
      }

      sendResponse({ ok: true, ignored: true });
      return true;
    }

    if (message && message.action === "grokViewerRegenViaMain") {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      const payload = message.payload;
      const requestId = message.requestId;
      if (!tabId || !payload || !requestId) {
        sendResponse({ ok: false, status: 0, error: "missing-tab-payload-or-request-id" });
        return true;
      }
      chrome.scripting.executeScript(
        {
          target: { tabId },
          world: "MAIN",
          func: async (requestPayload, rid, srcPostId) => {
            const requestIdText = String(rid || "");
            const sourcePostIdText = String(srcPostId || "").trim();
            const sourcePostUrl = sourcePostIdText ? `${window.location.origin}/imagine/post/${sourcePostIdText}` : "";
            const makeUuidLike = () => {
              try {
                if (window.crypto && typeof window.crypto.randomUUID === "function") {
                  return window.crypto.randomUUID();
                }
              } catch (error) {}
              const part = (size) => {
                let out = "";
                const chars = "0123456789abcdef";
                for (let i = 0; i < size; i += 1) {
                  out += chars[Math.floor(Math.random() * chars.length)];
                }
                return out;
              };
              return `${part(8)}-${part(4)}-${part(4)}-${part(4)}-${part(12)}`;
            };
            const encodeBase64 = (value) => {
              const text = String(value || "");
              try {
                return btoa(unescape(encodeURIComponent(text)));
              } catch (error) {
                try {
                  return btoa(text);
                } catch (error2) {
                  return "";
                }
              }
            };
            const looksLikeStatsigHeader = (value) => {
              const text = String(value || "").trim();
              if (!text) return false;
              if (text.length < 80 || text.length > 140) return false;
              return /^[A-Za-z0-9+/_=-]+$/.test(text);
            };
            const makeStatsigLikeId = () => {
              try {
                if (window.crypto && typeof window.crypto.getRandomValues === "function") {
                  const bytes = new Uint8Array(70);
                  window.crypto.getRandomValues(bytes);
                  let binary = "";
                  for (let i = 0; i < bytes.length; i += 1) {
                    binary += String.fromCharCode(bytes[i]);
                  }
                  const generated = btoa(binary).replace(/=+$/g, "");
                  if (looksLikeStatsigHeader(generated)) return generated;
                }
              } catch (error) {}
              const seed = `${Date.now()}-${Math.random()}-${requestIdText}-${String(window.location.href || "")}-${makeUuidLike()}`;
              const fallback = encodeBase64(seed + seed).replace(/=+$/g, "");
              if (looksLikeStatsigHeader(fallback)) return fallback;
              return encodeBase64(`${seed}-${seed}-${seed}`).replace(/=+$/g, "").slice(0, 96);
            };
            const extractStatsigFromValue = (value) => {
              if (!value) return "";
              if (typeof value === "string") {
                const trimmed = value.trim();
                if (!trimmed) return "";
                if (!looksLikeStatsigHeader(trimmed)) return "";
                return trimmed;
              }
              if (typeof value === "object") {
                const stable =
                  value.stableID ||
                  value.stableId ||
                  value.statsigStableId ||
                  value.statsig_stable_id ||
                  value.statsigId ||
                  value.id ||
                  "";
                if (stable && typeof stable === "string") {
                  const stableText = stable.trim();
                  if (looksLikeStatsigHeader(stableText)) return stableText;
                }
              }
              return "";
            };
            const resolveStatsigId = () => {
              const fromHook = extractStatsigFromValue(window.__grokViewerLastStatsigId || "");
              if (fromHook) return { value: fromHook, source: "page-hook" };
              const fromStorage = (storageObj) => {
                if (!storageObj) return "";
                const directKeys = [
                  "statsig.stable_id",
                  "statsigStableId",
                  "statsig_stable_id",
                  "x-statsig-id",
                  "x_statsig_id"
                ];
                for (let i = 0; i < directKeys.length; i += 1) {
                  try {
                    const raw = storageObj.getItem(directKeys[i]);
                    const extracted = extractStatsigFromValue(raw);
                    if (extracted) return extracted;
                  } catch (error) {}
                }
                let keys = [];
                try {
                  keys = Object.keys(storageObj);
                } catch (error) {
                  keys = [];
                }
                for (let i = 0; i < keys.length; i += 1) {
                  const key = String(keys[i] || "").toLowerCase();
                  if (!key.includes("statsig")) continue;
                  let raw = "";
                  try {
                    raw = storageObj.getItem(keys[i]);
                  } catch (error) {
                    raw = "";
                  }
                  if (!raw) continue;
                  const direct = extractStatsigFromValue(raw);
                  if (direct) return direct;
                  try {
                    const parsed = JSON.parse(raw);
                    const nested =
                      extractStatsigFromValue(parsed) ||
                      extractStatsigFromValue(parsed && parsed.stableID) ||
                      extractStatsigFromValue(parsed && parsed.stableId) ||
                      extractStatsigFromValue(parsed && parsed.statsigStableId) ||
                      extractStatsigFromValue(parsed && parsed.statsig_stable_id) ||
                      extractStatsigFromValue(parsed && parsed.statsigId) ||
                      extractStatsigFromValue(parsed && parsed.id) ||
                      extractStatsigFromValue(parsed && parsed.value);
                    if (nested) return nested;
                  } catch (error) {}
                }
                return "";
              };
              const fromLocal = (() => {
                try {
                  return fromStorage(window.localStorage);
                } catch (error) {
                  return "";
                }
              })();
              if (fromLocal) return { value: fromLocal, source: "localStorage" };
              const fromSession = (() => {
                try {
                  return fromStorage(window.sessionStorage);
                } catch (error) {
                  return "";
                }
              })();
              if (fromSession) return { value: fromSession, source: "sessionStorage" };
              return { value: makeStatsigLikeId(), source: "generated" };
            };
            const statsigInfo = resolveStatsigId();
            const statsigId = statsigInfo && statsigInfo.value ? String(statsigInfo.value) : "";
            const statsigSource = statsigInfo && statsigInfo.source ? String(statsigInfo.source) : "unknown";
            const ensureControllers = () => {
              if (!window.__grokViewerRegenControllers || typeof window.__grokViewerRegenControllers !== "object") {
                window.__grokViewerRegenControllers = {};
              }
              return window.__grokViewerRegenControllers;
            };
            const controllers = ensureControllers();
            const post = (type, extra) => {
              try {
                window.postMessage(
                  {
                    source: "grok-viewer",
                    type,
                    requestId: requestIdText,
                    ...(extra || {})
                  },
                  "*"
                );
              } catch (error) {}
            };
            const normalizeUrl = (url) => {
              if (!url || typeof url !== "string") return "";
              if (url.startsWith("http")) return url;
              if (url.startsWith("users/") || url.startsWith("/users/")) {
                const trimmed = url.replace(/^\//, "");
                return `https://assets.grok.com/${trimmed}`;
              }
              if (url.startsWith("/imagine-public/")) return `https://imagine-public.x.ai${url}`;
              if (url.startsWith("imagine-public/")) return `https://imagine-public.x.ai/${url}`;
              return url;
            };
            const tracker = {
              progress: 0,
              moderated: false,
              videoPostId: "",
              videoUrl: "",
              thumbnailImageUrl: "",
              parentPostId: "",
              queryType: "",
              status: 0
            };
            const applyStream = (stream) => {
              if (!stream || typeof stream !== "object") return;
              const next = { changed: false };
              const progress = Number(stream.progress);
              if (Number.isFinite(progress)) {
                const pct = Math.max(0, Math.min(100, Math.round(progress)));
                if (pct !== tracker.progress) {
                  tracker.progress = pct;
                  next.changed = true;
                }
              }
              if (stream.moderated === true && tracker.moderated !== true) {
                tracker.moderated = true;
                next.changed = true;
              }
              if (stream.videoPostId && tracker.videoPostId !== String(stream.videoPostId)) {
                tracker.videoPostId = String(stream.videoPostId);
                next.changed = true;
              }
              if (stream.videoUrl) {
                const normalizedVideo = normalizeUrl(stream.videoUrl);
                if (normalizedVideo && tracker.videoUrl !== normalizedVideo) {
                  tracker.videoUrl = normalizedVideo;
                  next.changed = true;
                }
              }
              if (stream.thumbnailImageUrl) {
                const normalizedThumb = normalizeUrl(stream.thumbnailImageUrl);
                if (normalizedThumb && tracker.thumbnailImageUrl !== normalizedThumb) {
                  tracker.thumbnailImageUrl = normalizedThumb;
                  next.changed = true;
                }
              }
              if (stream.parentPostId && tracker.parentPostId !== String(stream.parentPostId)) {
                tracker.parentPostId = String(stream.parentPostId);
                next.changed = true;
              }
              if (next.changed) {
                post("regen-stream", {
                  progress: tracker.progress,
                  moderated: tracker.moderated,
                  videoPostId: tracker.videoPostId,
                  videoUrl: tracker.videoUrl,
                  thumbnailImageUrl: tracker.thumbnailImageUrl,
                  parentPostId: tracker.parentPostId
                });
              }
            };
            const parseLine = (line) => {
              if (!line) return;
              let parsed = null;
              try {
                parsed = JSON.parse(line);
              } catch (error) {
                parsed = null;
              }
              if (!parsed || typeof parsed !== "object") return;
              const responseNode = parsed && parsed.result && parsed.result.response ? parsed.result.response : null;
              if (!responseNode || typeof responseNode !== "object") return;
              const queryAction = responseNode.queryAction;
              if (queryAction && queryAction.type) {
                const queryType = String(queryAction.type);
                if (queryType && tracker.queryType !== queryType) {
                  tracker.queryType = queryType;
                  post("regen-query", { queryType });
                }
              }
              applyStream(responseNode.streamingVideoGenerationResponse);
            };

            const consumeConversationResponse = async (response) => {
              if (response.body && typeof response.body.getReader === "function") {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                while (true) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  buffer += decoder.decode(chunk.value, { stream: true });
                  let newline = buffer.indexOf("\n");
                  while (newline >= 0) {
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + 1);
                    if (line) parseLine(line);
                    newline = buffer.indexOf("\n");
                  }
                }
                buffer += decoder.decode();
                const tail = buffer.trim();
                if (tail) parseLine(tail);
                return;
              }
              const text = await response.text();
              const lines = String(text || "")
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);
              for (let i = 0; i < lines.length; i += 1) {
                parseLine(lines[i]);
              }
            };

            const runConversationFetch = async (fetchFn, channelLabel, includeReferrer) => {
              if (controller.signal.aborted) {
                const abortError = new Error("aborted-before-fetch");
                abortError.name = "AbortError";
                throw abortError;
              }
              const xaiRequestId = makeUuidLike();
              const statsigHeader = String(statsigId || "").trim();
              const requestHeaders = {
                "content-type": "application/json",
                accept: "*/*",
                "x-xai-request-id": xaiRequestId
              };
              if (statsigHeader) {
                requestHeaders["x-statsig-id"] = statsigHeader;
              }
              const requestInit = {
                method: "POST",
                credentials: "include",
                headers: requestHeaders,
                body: JSON.stringify(requestPayload || {}),
                signal: controller.signal
              };
              if (includeReferrer && sourcePostUrl) {
                requestInit.referrer = sourcePostUrl;
                requestInit.referrerPolicy = "strict-origin-when-cross-origin";
              }
              const response = await fetchFn("/rest/app-chat/conversations/new", requestInit);
              tracker.status = Number(response.status || 0);
              const hasStatsig = !!statsigHeader;
              const baseHttpData = {
                status: tracker.status,
                channel: channelLabel,
                xaiRequestId,
                hasStatsig,
                statsigSource,
                statsigLength: statsigHeader.length
              };
              if (!response.ok) {
                let challengeDetected = false;
                let errorHint = "";
                try {
                  const contentType = String((response.headers && response.headers.get && response.headers.get("content-type")) || "");
                  if (contentType.toLowerCase().includes("text/html")) {
                    const bodyText = await response.text();
                    const sample = String(bodyText || "").slice(0, 1600);
                    if (/just a moment|enable javascript and cookies|cf[-_]?challenge|challenge-platform/i.test(sample)) {
                      challengeDetected = true;
                      errorHint = "cloudflare-challenge";
                    } else {
                      errorHint = "html-error-response";
                    }
                  } else {
                    errorHint = "http-error";
                  }
                } catch (error) {}
                post("regen-http", { ...baseHttpData, challengeDetected, errorHint });
                return {
                  ok: false,
                  status: tracker.status,
                  channel: channelLabel,
                  xaiRequestId,
                  hasStatsig,
                  statsigSource,
                  statsigLength: statsigHeader.length,
                  challengeDetected,
                  errorHint,
                  moderated: tracker.moderated,
                  videoPostId: tracker.videoPostId,
                  videoUrl: tracker.videoUrl,
                  thumbnailImageUrl: tracker.thumbnailImageUrl,
                  parentPostId: tracker.parentPostId
                };
              }
              post("regen-http", baseHttpData);
              await consumeConversationResponse(response);
              return {
                ok: true,
                status: tracker.status,
                channel: channelLabel,
                xaiRequestId,
                hasStatsig,
                statsigSource,
                statsigLength: statsigHeader.length,
                progress: tracker.progress,
                moderated: tracker.moderated,
                videoPostId: tracker.videoPostId,
                videoUrl: tracker.videoUrl,
                thumbnailImageUrl: tracker.thumbnailImageUrl,
                parentPostId: tracker.parentPostId
              };
            };
            const runWarmupFetch = async (fetchFn) => {
              const warmupTargets = [
                "/rest/app-chat/conversations?pageSize=60&filterIsStarred=true",
                "/rest/app-chat/conversations?pageSize=60"
              ];
              for (let i = 0; i < warmupTargets.length; i += 1) {
                if (controller.signal.aborted) {
                  const abortError = new Error("aborted-before-warmup");
                  abortError.name = "AbortError";
                  throw abortError;
                }
                const xaiRequestId = makeUuidLike();
                const statsigHeader = String(statsigId || "").trim();
                const warmupHeaders = { accept: "*/*", "x-xai-request-id": xaiRequestId };
                if (statsigHeader) warmupHeaders["x-statsig-id"] = statsigHeader;
                const response = await fetchFn(warmupTargets[i], {
                  method: "GET",
                  credentials: "include",
                  headers: warmupHeaders,
                  signal: controller.signal
                });
                const status = Number(response.status || 0);
                let challengeDetected = false;
                let errorHint = "";
                if (!response.ok) {
                  try {
                    const contentType = String((response.headers && response.headers.get && response.headers.get("content-type")) || "");
                    if (contentType.toLowerCase().includes("text/html")) {
                      const bodyText = await response.text();
                      const sample = String(bodyText || "").slice(0, 1600);
                      if (/just a moment|enable javascript and cookies|cf[-_]?challenge|challenge-platform/i.test(sample)) {
                        challengeDetected = true;
                        errorHint = "cloudflare-challenge";
                      } else {
                        errorHint = "html-error-response";
                      }
                    } else {
                      errorHint = "http-error";
                    }
                  } catch (error) {}
                }
                post("regen-http", {
                  status,
                  channel: "warmup-conversations",
                  xaiRequestId,
                  hasStatsig: !!statsigHeader,
                  statsigSource,
                  statsigLength: statsigHeader.length,
                  challengeDetected,
                  errorHint
                });
                if (!response.ok) {
                  return {
                    ok: false,
                    status,
                    channel: "warmup-conversations",
                    xaiRequestId,
                    hasStatsig: !!statsigHeader,
                    statsigSource,
                    statsigLength: statsigHeader.length,
                    challengeDetected,
                    errorHint,
                    moderated: tracker.moderated,
                    videoPostId: tracker.videoPostId,
                    videoUrl: tracker.videoUrl,
                    thumbnailImageUrl: tracker.thumbnailImageUrl,
                    parentPostId: tracker.parentPostId
                  };
                }
              }
              return { ok: true, status: 200 };
            };

            const loadPostFrame = () =>
              new Promise((resolve, reject) => {
                if (!sourcePostUrl) {
                  reject(new Error("missing-source-post-url"));
                  return;
                }
                const frame = document.createElement("iframe");
                frame.style.cssText = "position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;pointer-events:none;";
                frame.setAttribute("aria-hidden", "true");
                let settled = false;
                let timeoutId = null;
                const cleanupListeners = () => {
                  frame.onload = null;
                  frame.onerror = null;
                  if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                  }
                  if (controller && controller.signal) {
                    controller.signal.removeEventListener("abort", onAbort);
                  }
                };
                const finish = (ok, value) => {
                  if (settled) return;
                  settled = true;
                  cleanupListeners();
                  if (!ok) {
                    if (frame.parentNode) frame.parentNode.removeChild(frame);
                    reject(value);
                    return;
                  }
                  resolve(frame);
                };
                const onAbort = () => {
                  const abortError = new Error("aborted-while-loading-frame");
                  abortError.name = "AbortError";
                  finish(false, abortError);
                };
                frame.onload = () => finish(true, frame);
                frame.onerror = () => finish(false, new Error("post-frame-load-failed"));
                if (controller && controller.signal) {
                  if (controller.signal.aborted) {
                    onAbort();
                    return;
                  }
                  controller.signal.addEventListener("abort", onAbort, { once: true });
                }
                timeoutId = setTimeout(() => finish(false, new Error("post-frame-timeout")), 15000);
                frame.src = sourcePostUrl;
                (document.documentElement || document.body || document).appendChild(frame);
              });

            const controller = new AbortController();
            if (requestIdText && controllers[requestIdText]) {
              try {
                controllers[requestIdText].abort();
              } catch (error) {}
            }
            if (requestIdText) controllers[requestIdText] = controller;
            try {
              const warmupAttempt = await runWarmupFetch(window.fetch.bind(window));
              if (!warmupAttempt.ok) return warmupAttempt;
              const firstAttempt = await runConversationFetch(window.fetch.bind(window), "main-world", false);
              if (firstAttempt.ok) return firstAttempt;

              if (Number(firstAttempt.status || 0) === 403 && sourcePostUrl) {
                let frame = null;
                try {
                  post("regen-http", {
                    status: 403,
                    channel: "main-world->iframe-fallback",
                    hasStatsig: !!statsigId,
                    statsigSource,
                    statsigLength: statsigId.length,
                    challengeDetected: firstAttempt.challengeDetected === true,
                    errorHint: firstAttempt.errorHint || ""
                  });
                  try {
                    frame = await loadPostFrame();
                  } catch (frameError) {
                    post("regen-http", {
                      status: 403,
                      channel: "post-iframe-load-failed",
                      hasStatsig: !!statsigId,
                      statsigSource,
                      statsigLength: statsigId.length,
                      errorHint: String((frameError && frameError.message) || frameError || "post-frame-load-failed")
                    });
                    return firstAttempt;
                  }
                  const frameWindow = frame && frame.contentWindow ? frame.contentWindow : null;
                  if (!frameWindow || typeof frameWindow.fetch !== "function") {
                    post("regen-http", {
                      status: 403,
                      channel: "post-iframe-unavailable",
                      hasStatsig: !!statsigId,
                      statsigSource,
                      statsigLength: statsigId.length,
                      errorHint: "missing-frame-fetch"
                    });
                    return firstAttempt;
                  }
                  const secondAttempt = await runConversationFetch(frameWindow.fetch.bind(frameWindow), "post-iframe", false);
                  if (secondAttempt.ok) return secondAttempt;
                  return secondAttempt;
                } finally {
                  if (frame && frame.parentNode) {
                    frame.parentNode.removeChild(frame);
                  }
                }
              }

              return firstAttempt;
            } catch (error) {
              const aborted =
                !!(
                  error &&
                  (error.name === "AbortError" || String(error.message || error).toLowerCase().includes("abort"))
                );
              return {
                ok: false,
                status: tracker.status || 0,
                aborted,
                error: String((error && error.message) || error || "regen-main-failed"),
                channel: "main-world",
                hasStatsig: !!statsigId,
                statsigSource,
                statsigLength: statsigId.length,
                moderated: tracker.moderated,
                videoPostId: tracker.videoPostId,
                videoUrl: tracker.videoUrl,
                thumbnailImageUrl: tracker.thumbnailImageUrl,
                parentPostId: tracker.parentPostId
              };
            } finally {
              if (requestIdText && controllers[requestIdText] === controller) {
                delete controllers[requestIdText];
              }
            }
          },
          args: [payload, requestId, message.sourcePostId || ""]
        },
        (results) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, status: 0, error: chrome.runtime.lastError.message });
            return;
          }
          const payloadResult = results && results[0] ? results[0].result : null;
          sendResponse(payloadResult || { ok: false, status: 0, error: "no-main-result" });
        }
      );
      return true;
    }

    if (message && message.action === "grokViewerRegenAbortViaMain") {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      const requestId = message.requestId;
      if (!tabId || !requestId) {
        sendResponse({ ok: false, error: "missing-tab-or-request-id" });
        return true;
      }
      chrome.scripting.executeScript(
        {
          target: { tabId },
          world: "MAIN",
          func: (rid) => {
            const requestIdText = String(rid || "");
            const controllers = window.__grokViewerRegenControllers || {};
            const controller = controllers && requestIdText ? controllers[requestIdText] : null;
            if (controller && typeof controller.abort === "function") {
              try {
                controller.abort();
              } catch (error) {}
              return { ok: true };
            }
            return { ok: false };
          },
          args: [requestId]
        },
        (results) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          const payloadResult = results && results[0] ? results[0].result : null;
          sendResponse(payloadResult || { ok: false });
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

    if (message && message.action === "grokViewerOpenDownloads") {
      const filename = message.filename || "";
      const findDownload = (cb) => {
        if (!filename) {
          cb(null);
          return;
        }
        chrome.downloads.search({ query: [filename] }, (results) => {
          if (chrome.runtime.lastError || !results || !results.length) {
            cb(null);
            return;
          }
          const match =
            results.find((item) => item && item.filename && item.filename.endsWith(filename)) ||
            results.find((item) => item && item.filename && item.filename.includes(filename)) ||
            results[0];
          cb(match || null);
        });
      };
      const openDownloadsPage = () => {
        const ua = (navigator.userAgent || "").toLowerCase();
        const urls = [];
        if (ua.includes("opr") || ua.includes("opera")) urls.push("opera://downloads");
        if (ua.includes("brave")) urls.push("brave://downloads");
        urls.push("chrome://downloads");
        const tryOpen = (index) => {
          const url = urls[index];
          if (!url) {
            sendResponse({ ok: false, error: "no-downloads-url" });
            return;
          }
          chrome.tabs.create({ url }, () => {
            if (chrome.runtime.lastError) {
              tryOpen(index + 1);
              return;
            }
            sendResponse({ ok: true, method: "tab", url });
          });
        };
        tryOpen(0);
      };
      if (chrome.downloads && chrome.downloads.show) {
        findDownload((match) => {
          if (match && match.id) {
            try {
              chrome.downloads.show(match.id);
              sendResponse({ ok: true, method: "show", id: match.id });
            } catch (e) {
              openDownloadsPage();
            }
            return;
          }
          if (chrome.downloads && chrome.downloads.showDefaultFolder) {
            try {
              chrome.downloads.showDefaultFolder();
              sendResponse({ ok: true, method: "folder" });
              return;
            } catch (e) {}
          }
          openDownloadsPage();
        });
        return true;
      }
      openDownloadsPage();
      return true;
    }

    if (message && message.action === "grokViewerOpenDownloadSettingsAndReopen") {
      const urls = getDownloadSettingsUrls();
      const openAt = (index) => {
        const url = urls[index];
        if (!url) {
          sendResponse({ ok: false, error: "settings-url-unavailable" });
          return;
        }
        chrome.tabs.create({ url, active: true }, (tab) => {
          if (!chrome.runtime.lastError && tab && tab.id) {
            sendResponse({ ok: true, url, method: "tab" });
            return;
          }
          chrome.windows.create({ url, type: "normal", focused: true }, (win) => {
            if (chrome.runtime.lastError || !win || !win.id) {
              openAt(index + 1);
              return;
            }
            sendResponse({ ok: true, url, method: "window" });
          });
        });
      };
      openAt(0);
      return true;
    }

    if (message && message.action === "grokViewerWaitForDownload") {
      const filename = message.filename || "";
      const requireComplete = !!message.requireComplete;
      const timeoutMs = 15 * 60 * 1000;
      const start = Date.now();
      const poll = () => {
        if (!filename) {
          sendResponse({ ok: false, error: "no-filename" });
          return;
        }
        chrome.downloads.search({ query: [filename] }, (results) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          const match =
            (results || []).find((item) => item && item.filename && item.filename.endsWith(filename)) ||
            (results || []).find((item) => item && item.filename && item.filename.includes(filename));
          if (match && (!requireComplete || match.state === "complete")) {
            sendResponse({ ok: true, id: match.id, state: match.state });
            return;
          }
          if (Date.now() - start > timeoutMs) {
            sendResponse({ ok: false, error: "timeout" });
            return;
          }
          setTimeout(poll, 700);
        });
      };
      poll();
      return true;
    }

    if (message && message.action === "grokViewerGetDownloadById") {
      const downloadId = Number(message.downloadId || 0);
      if (!downloadId) {
        sendResponse({ ok: false, error: "no-download-id" });
        return true;
      }
      chrome.downloads.search({ id: downloadId }, (results) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        const item = results && results.length ? results[0] : null;
        if (!item) {
          sendResponse({ ok: false, error: "not-found" });
          return;
        }
        sendResponse({
          ok: true,
          id: item.id,
          state: item.state || "",
          error: item.error || "",
          filename: item.filename || ""
        });
      });
      return true;
    }

    return false;
  });
})();

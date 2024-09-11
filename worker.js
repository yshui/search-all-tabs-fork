"use strict";

const tab_highlight = {};
let index_queue = {};

chrome.runtime.onMessage.addListener((request, sender, response) => {
  if (request.method === "find") {
    chrome.tabs.update(request.tabId, {
      active: true,
    });
    chrome.windows.update(request.windowId, {
      focused: true,
    });
    chrome.storage.local.get(
      {
        strict: false,
      },
      (prefs) => {
        if (
          request.snippet &&
          (request.snippet.includes("<b>") || prefs.strict)
        ) {
          tab_highlight[request.tabId] = request;
          chrome.scripting.executeScript(
            {
              target: {
                tabId: request.tabId,
                allFrames: true,
              },
              files: ["/data/highlight.js"],
            },
            () => chrome.runtime.lastError
          );
        }
        try {
          response();
        } catch (e) {}
      }
    );

    return true;
  } else if (request.method === "get_highlight") {
    response(tab_highlight[sender.tab.id]);
  } else if (request.method === "delete") {
    chrome.tabs.remove(request.ids);
  } else if (request.method === "group") {
    const tabId = request.ids.shift();
    chrome.windows.create(
      {
        tabId,
      },
      (w) => {
        if (request.ids.length) {
          chrome.tabs.move(request.ids, {
            windowId: w.id,
            index: -1,
          });
          chrome.windows.update(w.id, {
            focused: true,
          });
        }
      }
    );
  } else if (request.method === "get_jobs") {
    console.log(`tab delta: ${Object.keys(index_queue)}`);
    response(index_queue);
    index_queue = {};
  }
});

/* action */
chrome.action.onClicked.addListener((tab) =>
  chrome.tabs.create({
    url: `/data/popup/index.html?mode=tab`,
    index: tab.index + 1,
  })
);
{
  const startup = () =>
    chrome.storage.local.get(
      {
        "open-mode": "popup",
      },
      (prefs) => {
        chrome.action.setPopup({
          popup: prefs["open-mode"] === "popup" ? "/data/popup/index.html" : "",
        });
      }
    );
  chrome.runtime.onStartup.addListener(startup);
  chrome.runtime.onInstalled.addListener(startup);
}
chrome.storage.onChanged.addListener((ps) => {
  if (ps["open-mode"]) {
    chrome.action.setPopup({
      popup:
        ps["open-mode"].newValue === "popup" ? "/data/popup/index.html" : "",
    });
  }
});

// remove all remaining databases on startup
{
  const once = async () => {
    for (const { name } of await indexedDB.databases()) {
      indexedDB.deleteDatabase(name);
    }

    index_queue = {};
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      index_queue[tab.id] = 1;
    }
    chrome.tabs.onRemoved.addListener((tabId) => {
      console.log(`Removed tab: ${tabId}`);
      delete tab_highlight[tabId];
      index_queue[tabId] = -1;
    });
    chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
      if (info.discarded === true) {
        // Don't re-index discarded tabs
        return;
      }
      console.log(`Updated tab: ${tabId}`);
      index_queue[tabId] = 0;
      // console.log(`Updated tab: ${tabId}`);
      // console.log("Changed attributes: ", info);
      // console.log("New tab Info: ", tab);
    });
    chrome.tabs.onActivated.addListener(({ tabId }) => {
      console.log(`Activated tab: ${tabId}`);
      index_queue[tabId] = 0;
    });
    chrome.tabs.onCreate.addListener((tab) => {
      console.log(`Created tab: ${tab.id}`);
      index_queue[tab.id] = 1;
    });
  };
  chrome.runtime.onInstalled.addListener(once);
  chrome.runtime.onStartup.addListener(once);
}

/* FAQs & Feedback */
{
  const {
    management,
    runtime: { onInstalled, setUninstallURL, getManifest },
    storage,
    tabs,
  } = chrome;
  if (navigator.webdriver !== true) {
    const page = getManifest().homepage_url;
    const { name, version } = getManifest();
    onInstalled.addListener(({ reason, previousVersion }) => {
      management.getSelf(
        ({ installType }) =>
          installType === "normal" &&
          storage.local.get(
            {
              faqs: true,
              "last-update": 0,
            },
            (prefs) => {
              if (reason === "install" || (prefs.faqs && reason === "update")) {
                const doUpdate =
                  (Date.now() - prefs["last-update"]) / 1000 / 60 / 60 / 24 >
                  45;
                if (doUpdate && previousVersion !== version) {
                  tabs.query({ active: true, currentWindow: true }, (tbs) =>
                    tabs.create({
                      url:
                        page +
                        "?version=" +
                        version +
                        (previousVersion ? "&p=" + previousVersion : "") +
                        "&type=" +
                        reason,
                      active: reason === "install",
                      ...(tbs && tbs.length && { index: tbs[0].index + 1 }),
                    })
                  );
                  storage.local.set({ "last-update": Date.now() });
                }
              }
            }
          )
      );
    });
    setUninstallURL(
      page +
        "?rd=feedback&name=" +
        encodeURIComponent(name) +
        "&version=" +
        version
    );
  }
}

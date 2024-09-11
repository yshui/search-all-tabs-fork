"use strict";

let tab_highlight = null;
let index_queue = null;
let all_seen_tabs = null;

const save = async (init = false) => {
  if (index_queue === null || all_seen_tabs === null || tab_highlight === null) {
    return false;
  }
  let payload = {index_queue, all_seen_tabs, tab_highlight};
  if (init) {
    payload.docs = 0;
  }
  await chrome.storage.session.set(payload);
  return true;
}

// remove all remaining databases on startup
const once = async () => {
  for (const { name } of await indexedDB.databases()) {
    indexedDB.deleteDatabase(name);
  }

  tab_highlight = {};
  index_queue = {};
  all_seen_tabs = {};
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    index_queue[tab.id] = 1;
  }
  await save(true);
};

const restore = async () => {
  if (index_queue !== null && all_seen_tabs !== null && tab_highlight !== null) {
    return true;
  }
  const obj = await chrome.storage.session.get({
    index_queue: null,
    all_seen_tabs: null,
    tab_highlight: null,
  });
  index_queue = obj.index_queue;
  all_seen_tabs = obj.all_seen_tabs;
  tab_highlight = obj.tab_highlight;
  if (index_queue === null || all_seen_tabs === null || tab_highlight === null) {
      await once();
  }
};
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await restore();
  console.log(`Removed tab: ${tabId}`);
  delete tab_highlight[tabId];
  if (tabId in all_seen_tabs) {
    delete all_seen_tabs[tabId];
    index_queue[tabId] = -1;
  } else {
    delete index_queue[tabId];
  }
  await save();
});
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.discarded === true) {
    // Don't re-index discarded tabs
    return;
  }
  await restore();
  if (!(tabId in all_seen_tabs)) {
    console.log(`New tab ${tabId}`);
    index_queue[tabId] = 1;
  } else {
    console.log(`Updated tab: ${tabId}`);
    index_queue[tabId] = 0;
  }
  console.log(`Updated tab: ${tabId}`);
  console.log("Changed attributes: ", info);
  console.log("New tab Info: ", tab);
  await save();
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await restore();
  console.log(`Activated tab: ${tabId}`);
  if (!(tabId in all_seen_tabs)) {
    console.log("Activated tab was never seen.");
    index_queue[tabId] = 1;
  } else {
    index_queue[tabId] = 0;
  }
  await save();
});

chrome.runtime.onMessage.addListener(async (request, sender, response) => {
  if (request.method === "find") {
    await restore();
    try {
      chrome.tabs.update(request.tabId, {
        active: true,
      });
      chrome.windows.update(request.windowId, {
        focused: true,
      });
    } catch (e) {
      console.warn(`failed to activate tab ${request.tabId}: ${e}`);
      return;
    }
    let prefs = await chrome.storage.local.get({strict: false});
    if (
      request.snippet &&
      (request.snippet.includes("<b>") || prefs.strict)
    ) {
      tab_highlight[request.tabId] = request;
      await save();
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
  }

  if (request.method === "get_highlight") {
    await restore();
    return tab_highlight[sender.tab.id];
  }

  if (request.method === "delete") {
    chrome.tabs.remove(request.ids);
    return;
  }

  if (request.method === "group") {
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
    return;
  }

  if (request.method === "get_jobs") {
    await restore();
    console.log(`tab delta: ${Object.keys(index_queue)}`);
    return index_queue;
  }

  if (request.method === "index_complete") {
    await restore();
    console.log("index completed");
    for (const [k, _] of Object.entries(index_queue)) {
      all_seen_tabs[k] = true;
    }
    index_queue = {};
    await save();
    return;
  }

  throw "Invalid request";
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

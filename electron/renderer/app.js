const state = {
  latest: null,
  selectedClaudeModel: null,
  browser: null,
};

let lastBrowserHostBoundsKey = "";
let browserBoundsSyncFrameId = 0;

const desktopApp = window.desktopApp;

const elements = {
  statusPill: document.querySelector("#status-pill"),
  statusMessage: document.querySelector("#status-message"),
  gatewayUrl: document.querySelector("#gateway-url"),
  helperUrl: document.querySelector("#helper-url"),
  startedAt: document.querySelector("#started-at"),
  gatewayToken: document.querySelector("#gateway-token"),
  claudeModel: document.querySelector("#claude-model"),
  protocol: document.querySelector("#protocol"),
  baseUrl: document.querySelector("#base-url"),
  apiKey: document.querySelector("#api-key"),
  guideSteps: document.querySelector("#guide-steps"),
  models: document.querySelector("#models"),
  logsPath: document.querySelector("#logs-path"),
  bindingsPath: document.querySelector("#bindings-path"),
  configPath: document.querySelector("#config-path"),
  settingsForm: document.querySelector("#settings-form"),
  copyClaudeCommand: document.querySelector("#copy-claude-command"),
  restartButton: document.querySelector("#restart-button"),
  openLogs: document.querySelector("#open-logs"),
  openBindings: document.querySelector("#open-bindings"),
  openConfig: document.querySelector("#open-config"),
  browserForm: document.querySelector("#browser-form"),
  browserBack: document.querySelector("#browser-back"),
  browserForward: document.querySelector("#browser-forward"),
  browserReload: document.querySelector("#browser-reload"),
  browserTabs: document.querySelector("#browser-tabs"),
  browserUrl: document.querySelector("#browser-url"),
  browserTitle: document.querySelector("#browser-title"),
  browserLoading: document.querySelector("#browser-loading"),
  browserError: document.querySelector("#browser-error"),
  browserHost: document.querySelector("#browser-host"),
  newDeepseekTab: document.querySelector("#new-deepseek-tab"),
  newQwenTab: document.querySelector("#new-qwen-tab"),
};

function requireDesktopApp() {
  if (desktopApp) {
    return desktopApp;
  }

  throw new Error(
    "Desktop bridge failed to load. Restart the app and check the desktop debug logs if this keeps happening.",
  );
}

async function refreshState() {
  try {
    const [nextState, nextBrowserState] = await Promise.all([
      requireDesktopApp().getState(),
      requireDesktopApp().getBrowserState(),
    ]);
    state.latest = nextState;
    state.browser = nextBrowserState;
    render(nextState);
    renderBrowser(nextBrowserState);
    syncBrowserHostBounds();
  } catch (error) {
    renderError(error);
  }
}

function render(nextState) {
  const isRunning = nextState.service.running;
  elements.statusPill.textContent = isRunning ? "Running" : "Stopped";
  elements.statusPill.className = `status-pill ${isRunning ? "running" : "stopped"}`;
  elements.statusMessage.textContent =
    nextState.service.lastError ??
    nextState.service.notice ??
    (isRunning
      ? "Gateway and helper are running inside the Electron main process."
      : "Services are currently stopped.");
  elements.gatewayUrl.textContent = nextState.service.gatewayUrl ?? "-";
  elements.helperUrl.textContent = nextState.service.helperUrl ?? "-";
  elements.startedAt.textContent = nextState.service.startedAt
    ? new Date(nextState.service.startedAt).toLocaleString()
    : "-";

  elements.gatewayToken.value = nextState.config.gatewayToken;

  elements.protocol.textContent = nextState.claudeCode.protocol;
  elements.baseUrl.textContent = nextState.claudeCode.baseUrl;
  elements.apiKey.textContent = nextState.claudeCode.apiKey;
  elements.guideSteps.replaceChildren(
    ...nextState.claudeCode.steps.map((step) => {
      const item = document.createElement("li");
      item.textContent = step;
      return item;
    }),
  );
  elements.models.replaceChildren(
    ...nextState.claudeCode.models.map((modelId) => {
      const pill = document.createElement("span");
      pill.className = "model-pill";
      pill.textContent = modelId;
      return pill;
    }),
  );
  renderClaudeModelOptions(nextState.claudeCode.models);

  elements.logsPath.textContent = nextState.service.requestLogDir;
  elements.bindingsPath.textContent = nextState.service.sessionBindingDir;
  elements.configPath.textContent = nextState.service.configPath;
  scheduleBrowserHostBoundsSync();
}

function renderClaudeModelOptions(modelIds) {
  const nextModel =
    state.selectedClaudeModel && modelIds.includes(state.selectedClaudeModel)
      ? state.selectedClaudeModel
      : modelIds[0] ?? "";

  state.selectedClaudeModel = nextModel;

  elements.claudeModel.replaceChildren(
    ...modelIds.map((modelId) => {
      const option = document.createElement("option");
      option.value = modelId;
      option.textContent = modelId;
      option.selected = modelId === nextModel;
      return option;
    }),
  );
}

function renderError(error) {
  elements.statusPill.textContent = "Error";
  elements.statusPill.className = "status-pill error";
  elements.statusMessage.textContent =
    error instanceof Error ? error.message : String(error);
}

function renderBrowser(nextBrowserState) {
  if (!nextBrowserState) {
    return;
  }

  state.browser = nextBrowserState;
  renderBrowserTabs(nextBrowserState.tabs ?? [], nextBrowserState.activeTabId ?? null);
  elements.browserUrl.value = nextBrowserState.url ?? "";
  elements.browserTitle.textContent = nextBrowserState.title ?? "Embedded Browser";
  elements.browserLoading.textContent = nextBrowserState.isLoading ? "Loading" : "Ready";
  elements.browserLoading.className = `status-pill ${nextBrowserState.isLoading ? "running" : ""}`.trim();
  elements.browserError.textContent = nextBrowserState.lastError ?? "";
  elements.browserBack.disabled = !nextBrowserState.canGoBack;
  elements.browserForward.disabled = !nextBrowserState.canGoForward;
  scheduleBrowserHostBoundsSync();
}

function renderBrowserTabs(tabs, activeTabId) {
  elements.browserTabs.replaceChildren(
    ...tabs.map((tab) => {
      const item = document.createElement("div");
      item.className = `browser-tab ${tab.id === activeTabId ? "active" : ""}`.trim();

      const activateButton = document.createElement("button");
      activateButton.type = "button";
      activateButton.className = "browser-tab-button";
      activateButton.dataset.tabId = tab.id;
      activateButton.dataset.action = "activate-tab";
      activateButton.textContent = getBrowserTabLabel(tab);

      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "browser-tab-close";
      closeButton.dataset.tabId = tab.id;
      closeButton.dataset.action = "close-tab";
      closeButton.setAttribute("aria-label", `Close ${getBrowserTabLabel(tab)}`);
      closeButton.textContent = "x";

      item.append(activateButton, closeButton);
      return item;
    }),
  );
}

function getBrowserTabLabel(tab) {
  const title = (tab.title ?? "").trim();
  if (title && title !== "Embedded Browser") {
    return title;
  }

  try {
    return new URL(tab.url ?? "").host || "New Tab";
  } catch {
    return tab.url ?? "New Tab";
  }
}

function syncBrowserHostBounds() {
  const rect = elements.browserHost.getBoundingClientRect();
  const bounds = {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  const nextKey = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
  if (nextKey === lastBrowserHostBoundsKey) {
    return;
  }

  lastBrowserHostBoundsKey = nextKey;
  requireDesktopApp().setBrowserBounds(bounds).catch(renderError);
}

function scheduleBrowserHostBoundsSync(frameCount = 3) {
  if (browserBoundsSyncFrameId) {
    cancelAnimationFrame(browserBoundsSyncFrameId);
    browserBoundsSyncFrameId = 0;
  }

  let remainingFrames = Math.max(1, frameCount);
  const run = () => {
    syncBrowserHostBounds();
    remainingFrames -= 1;
    if (remainingFrames > 0) {
      browserBoundsSyncFrameId = requestAnimationFrame(run);
      return;
    }
    browserBoundsSyncFrameId = 0;
  };

  browserBoundsSyncFrameId = requestAnimationFrame(run);
}

async function submitBrowserNavigation(url) {
  try {
    const nextBrowserState = await requireDesktopApp().navigateBrowser(url);
    renderBrowser(nextBrowserState);
  } catch (error) {
    renderError(error);
  }
}

async function createBrowserTab(input) {
  try {
    const nextBrowserState = await requireDesktopApp().createBrowserTab(input);
    renderBrowser(nextBrowserState);
  } catch (error) {
    renderError(error);
  }
}

async function activateBrowserTab(tabId) {
  try {
    const nextBrowserState = await requireDesktopApp().activateBrowserTab(tabId);
    renderBrowser(nextBrowserState);
  } catch (error) {
    renderError(error);
  }
}

async function closeBrowserTab(tabId) {
  try {
    const nextBrowserState = await requireDesktopApp().closeBrowserTab(tabId);
    renderBrowser(nextBrowserState);
  } catch (error) {
    renderError(error);
  }
}

elements.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const nextState = await requireDesktopApp().saveSettings({
      gatewayToken: elements.gatewayToken.value,
    });
    state.latest = nextState;
    render(nextState);
  } catch (error) {
    renderError(error);
  }
});

elements.claudeModel.addEventListener("change", () => {
  state.selectedClaudeModel = elements.claudeModel.value;
});

elements.copyClaudeCommand.addEventListener("click", async () => {
  try {
    const modelId = elements.claudeModel.value;
    const command = await requireDesktopApp().getClaudeCommand(modelId);
    requireDesktopApp().copyText(command);
    elements.statusMessage.textContent =
      `Claude Code command copied for ${modelId}. Paste it into your terminal to start \`claude\`.`;
  } catch (error) {
    renderError(error);
  }
});

elements.restartButton.addEventListener("click", async () => {
  try {
    const nextState = await requireDesktopApp().restartServices();
    state.latest = nextState;
    render(nextState);
  } catch (error) {
    renderError(error);
  }
});

elements.browserForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitBrowserNavigation(elements.browserUrl.value);
});

elements.browserBack.addEventListener("click", async () => {
  try {
    const nextBrowserState = await requireDesktopApp().browserBack();
    renderBrowser(nextBrowserState);
  } catch (error) {
    renderError(error);
  }
});

elements.browserForward.addEventListener("click", async () => {
  try {
    const nextBrowserState = await requireDesktopApp().browserForward();
    renderBrowser(nextBrowserState);
  } catch (error) {
    renderError(error);
  }
});

elements.browserReload.addEventListener("click", async () => {
  try {
    const nextBrowserState = await requireDesktopApp().browserReload();
    renderBrowser(nextBrowserState);
  } catch (error) {
    renderError(error);
  }
});

elements.newDeepseekTab.addEventListener("click", async () => {
  await createBrowserTab({ provider: "deepseek-web" });
});

elements.newQwenTab.addEventListener("click", async () => {
  await createBrowserTab({ provider: "qwen-web" });
});

elements.browserTabs.addEventListener("click", async (event) => {
  const target =
    event.target instanceof Element
      ? event.target.closest("[data-action]")
      : null;
  if (!target) {
    return;
  }

  const tabId = target.dataset.tabId;
  if (!tabId) {
    return;
  }

  if (target.dataset.action === "activate-tab") {
    await activateBrowserTab(tabId);
    return;
  }

  if (target.dataset.action === "close-tab") {
    await closeBrowserTab(tabId);
  }
});

elements.openLogs.addEventListener("click", () => requireDesktopApp().openPath("logs"));
elements.openBindings.addEventListener("click", () =>
  requireDesktopApp().openPath("bindings"),
);
elements.openConfig.addEventListener("click", () => requireDesktopApp().openPath("config"));

document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = button.getAttribute("data-copy-target");
    if (!state.latest) {
      return;
    }

    const value =
      target === "protocol"
        ? state.latest.claudeCode.protocol
        : target === "baseUrl"
          ? state.latest.claudeCode.baseUrl
          : state.latest.claudeCode.apiKey;

    requireDesktopApp().copyText(value);
  });
});

requireDesktopApp().onBrowserState((nextBrowserState) => {
  renderBrowser(nextBrowserState);
});

requireDesktopApp().onRequestBrowserBoundsSync(() => {
  scheduleBrowserHostBoundsSync();
});

const resizeObserver = new ResizeObserver(() => {
  scheduleBrowserHostBoundsSync();
});

resizeObserver.observe(elements.browserHost);
resizeObserver.observe(document.body);
window.addEventListener("resize", () => scheduleBrowserHostBoundsSync());
window.addEventListener("load", () => scheduleBrowserHostBoundsSync());
window.addEventListener("scroll", () => scheduleBrowserHostBoundsSync(), true);

void refreshState();

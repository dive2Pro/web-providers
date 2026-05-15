const state = {
  latest: null,
};

const desktopApp = window.desktopApp;

const elements = {
  statusPill: document.querySelector("#status-pill"),
  statusMessage: document.querySelector("#status-message"),
  gatewayUrl: document.querySelector("#gateway-url"),
  helperUrl: document.querySelector("#helper-url"),
  startedAt: document.querySelector("#started-at"),
  gatewayPort: document.querySelector("#gateway-port"),
  helperPort: document.querySelector("#helper-port"),
  gatewayToken: document.querySelector("#gateway-token"),
  protocol: document.querySelector("#protocol"),
  baseUrl: document.querySelector("#base-url"),
  apiKey: document.querySelector("#api-key"),
  guideSteps: document.querySelector("#guide-steps"),
  models: document.querySelector("#models"),
  logsPath: document.querySelector("#logs-path"),
  bindingsPath: document.querySelector("#bindings-path"),
  configPath: document.querySelector("#config-path"),
  settingsForm: document.querySelector("#settings-form"),
  restartButton: document.querySelector("#restart-button"),
  openLogs: document.querySelector("#open-logs"),
  openBindings: document.querySelector("#open-bindings"),
  openConfig: document.querySelector("#open-config"),
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
    const nextState = await requireDesktopApp().getState();
    state.latest = nextState;
    render(nextState);
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

  elements.gatewayPort.value = String(nextState.config.gatewayPort);
  elements.helperPort.value = String(nextState.config.helperPort);
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

  elements.logsPath.textContent = nextState.service.requestLogDir;
  elements.bindingsPath.textContent = nextState.service.sessionBindingDir;
  elements.configPath.textContent = nextState.service.configPath;
}

function renderError(error) {
  elements.statusPill.textContent = "Error";
  elements.statusPill.className = "status-pill error";
  elements.statusMessage.textContent =
    error instanceof Error ? error.message : String(error);
}

elements.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const nextState = await requireDesktopApp().saveSettings({
      gatewayPort: Number(elements.gatewayPort.value),
      helperPort: Number(elements.helperPort.value),
      gatewayToken: elements.gatewayToken.value,
    });
    state.latest = nextState;
    render(nextState);
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

void refreshState();

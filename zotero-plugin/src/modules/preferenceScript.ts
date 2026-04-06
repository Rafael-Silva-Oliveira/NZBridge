import { config } from "../../package.json";

export async function registerPrefsScripts(_window: Window) {
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
    };
  } else {
    addon.data.prefs.window = _window;
  }
  bindPrefEvents();
}

function bindPrefEvents() {
  addon.data.prefs!.window.document
    ?.querySelector(`#zotero-prefpane-${config.addonRef}-enable`)
    ?.addEventListener("command", (e: Event) => {
      ztoolkit.log(
        "n2z enable changed:",
        (e.target as XUL.Checkbox).checked,
      );
    });

  addon.data.prefs!.window.document
    ?.querySelector(`#zotero-prefpane-${config.addonRef}-defaultTags`)
    ?.addEventListener("change", (e: Event) => {
      ztoolkit.log(
        "n2z default tags changed:",
        (e.target as HTMLInputElement).value,
      );
    });

  addon.data.prefs!.window.document
    ?.querySelector(`#zotero-prefpane-${config.addonRef}-maxFileSize`)
    ?.addEventListener("change", (e: Event) => {
      ztoolkit.log(
        "n2z max file size changed:",
        (e.target as HTMLInputElement).value,
      );
    });
}

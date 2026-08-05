const versionLabel = document.getElementById("version-label");
if (versionLabel && typeof chrome !== "undefined" && chrome.runtime?.getManifest) {
  versionLabel.textContent = `v${chrome.runtime.getManifest().version}`;
}

document.querySelectorAll<HTMLAnchorElement>("[data-profile-link]").forEach((link) => {
  link.addEventListener("click", (event) => {
    if (typeof chrome === "undefined" || !chrome.tabs?.create) {
      return;
    }
    event.preventDefault();
    void chrome.tabs.create({ url: link.href });
    window.close();
  });
});

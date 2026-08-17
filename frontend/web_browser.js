import { setNativeDragFeedbackActive } from "./shared/drag.js";
import { resolveApiUrl } from "./web_shared.js";

export function createBrowserModule({
  state,
  refs,
  STORAGE_KEYS,
  FILTER_LABELS,
  ROLE_LABELS,
  saveStored,
  apiGet,
  apiPost,
  showError,
  confirmDiscardCaptionChanges,
  setCaptionEditorText,
  renderTags,
  renderGlobalTags,
  seedWorkspaceBrowserRootFromInputs,
  syncWorkspaceBrowserTargetVisibility,
  resolveWorkspaceInputPath,
  workspacePathRelativeToBrowserRoot,
  renderWorkspaceBrowser,
  closeUtilityPanel,
  setAiStatusLine,
  autoSaveProjectAfterWorkspaceOpen,
}) {
  const ITEM_DRAG_TYPE = "application/x-vds-item-name";
  const ITEM_ROLE_DRAG_TYPE = "application/x-vds-item-role";
  const VIEWER_ROLE_DRAG_TYPE = "application/x-vds-viewer-role";
  const IMAGE_ROLES = ["control1", "control2", "control3", "result"];
  const ITEM_CARD_SIZE_ANIMATION = {
    duration: 320,
    easing: "cubic-bezier(0.16, 1, 0.3, 1)",
  };
  const SPLIT_LIST_ANIMATION_MS = 500;
  const SPLIT_LIST_GAP = 10;
  const SPLIT_LIST_COLLAPSED_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" aria-hidden="true"><rect width="256" height="256" fill="none"/><rect x="48" y="48" width="160" height="160" rx="8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><line x1="128" y1="48" x2="128" y2="208" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><line x1="128" y1="80" x2="208" y2="80" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><line x1="128" y1="112" x2="208" y2="112" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><line x1="128" y1="144" x2="208" y2="144" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><line x1="128" y1="176" x2="208" y2="176" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/></svg>';
  const SPLIT_LIST_EXPANDED_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" aria-hidden="true"><rect width="256" height="256" fill="none"/><path fill="currentColor" d="M200,40H56A16,16,0,0,0,40,56V200a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V56A16,16,0,0,0,200,40ZM56,56h72V200H56Z"/></svg>';
  const itemContextMenu = document.querySelector("#itemContextMenu");
  const EXCLUSIVE_MENU_EVENT = "vds:close-exclusive-menus";
  let itemContextTarget = null;
  let itemContextCloseTimer = 0;
  let splitListRenderTimer = 0;
  let itemDragSource = null;
  let imagePreview = null;
  let documentFileDropGuardBound = false;

  function animateListHeaderControls() {
    const controls = [
      refs.toggleSplitListBtn,
      refs.locateSelectedBtn,
      refs.refreshListBtn,
    ].filter(Boolean);
    if (!controls.length) return;
    const beforeRects = new Map(
      controls.map((control) => [control, control.getBoundingClientRect()])
    );
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        controls.forEach((control) => {
          const beforeRect = beforeRects.get(control);
          if (!beforeRect || !control.isConnected) return;
          const afterRect = control.getBoundingClientRect();
          const deltaX = beforeRect.left - afterRect.left;
          const deltaY = beforeRect.top - afterRect.top;
          if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
          control.animate(
            [
              { transform: `translate(${deltaX}px, ${deltaY}px)` },
              { transform: "translate(0, 0)" },
            ],
            {
              duration: 420,
              easing: "cubic-bezier(0.22, 1, 0.36, 1)",
              fill: "both",
            }
          );
        });
      });
    });
  }

  function listPanels() {
    return [
      {
        id: "primary",
        itemList: refs.itemList,
        folderFilters: refs.itemFolderFilters,
        listStats: refs.listStats,
      },
      ...(state.splitListOpen && refs.secondaryItemList
        ? [{
            id: "secondary",
            itemList: refs.secondaryItemList,
            folderFilters: refs.secondaryItemFolderFilters,
            listStats: refs.secondaryListStats,
          }]
        : []),
    ].filter((panel) => panel.itemList);
  }

  function activeListPanelId() {
    return state.selectedPanel === "secondary" && state.splitListOpen ? "secondary" : "primary";
  }

  function panelItems(panelId = "primary") {
    return panelId === "secondary" ? (state.secondaryItems || []) : (state.items || []);
  }

  function setPanelItems(panelId, items) {
    if (panelId === "secondary") state.secondaryItems = items || [];
    else state.items = items || [];
  }

  function panelVisibleItems(panelId = "primary") {
    return panelId === "secondary" ? (state.secondaryVisibleItems || []) : (state.visibleItems || []);
  }

  function setPanelVisibleItems(panelId, items) {
    if (panelId === "secondary") state.secondaryVisibleItems = items || [];
    else state.visibleItems = items || [];
  }

  function panelFilter(panelId = "primary") {
    return panelId === "secondary" ? (state.secondaryFilter || "all") : (state.filter || "all");
  }

  function setPanelFilter(panelId, value) {
    if (panelId === "secondary") state.secondaryFilter = value || "all";
    else state.filter = value || "all";
  }

  function panelFolderFilter(panelId = "primary") {
    return panelId === "secondary" ? (state.secondaryItemFolderFilter || "") : (state.itemFolderFilter || "");
  }

  function effectivePanelFolderFilter(panelId = "primary") {
    return panelSegmentQuery(panelId).trim() ? "" : normalizeFolderPath(panelFolderFilter(panelId));
  }

  function setPanelFolderFilter(panelId, value) {
    const normalized = normalizeFolderPath(value);
    if (panelId === "secondary") state.secondaryItemFolderFilter = normalized;
    else state.itemFolderFilter = normalized;
    saveListViewState();
  }

  function panelSegmentQuery(panelId = "primary") {
    return panelId === "secondary" ? (state.secondarySegmentQuery || "") : (state.segmentQuery || "");
  }

  function setPanelSegmentQuery(panelId, value) {
    if (panelId === "secondary") state.secondarySegmentQuery = value || "";
    else state.segmentQuery = value || "";
  }

  function panelSearchMode(panelId = "primary") {
    return panelId === "secondary" ? (state.secondaryListSearchMode || "phrase") : (state.listSearchMode || "phrase");
  }

  function setPanelSearchMode(panelId, value) {
    if (panelId === "secondary") state.secondaryListSearchMode = value === "name" ? "name" : "phrase";
    else state.listSearchMode = value === "name" ? "name" : "phrase";
  }

  function panelSearchMatchMode(panelId = "primary") {
    return panelId === "secondary" ? (state.secondaryListSearchMatchMode || "contains") : (state.listSearchMatchMode || "contains");
  }

  function setPanelSearchMatchMode(panelId, value) {
    if (panelId === "secondary") state.secondaryListSearchMatchMode = value === "exact" ? "exact" : "contains";
    else state.listSearchMatchMode = value === "exact" ? "exact" : "contains";
  }

  function panelThumbMode(panelId = "primary") {
    return panelId === "secondary" ? (state.secondaryListThumbMode || "result") : (state.listThumbMode || "result");
  }

  function normalizeThumbMode(value) {
    const mode = `${value || "result"}`;
    const controlCount = activeControlCount();
    if (mode === "combined") return controlCount > 0 ? "combined" : "result";
    const controlMatch = mode.match(/^control([1-3])$/);
    if (controlMatch && controlCount >= Number(controlMatch[1])) return mode;
    return "result";
  }

  function thumbRolesForMode(mode) {
    const normalizedMode = normalizeThumbMode(mode);
    if (normalizedMode === "combined") return [...activeControlRoles(), "result"];
    if (/^control[1-3]$/.test(normalizedMode)) return [normalizedMode];
    return ["result"];
  }

  function workspaceSelectionKey() {
    const workspaceKey = state.workspace?.workspace_key || "";
    if (workspaceKey) return workspaceKey;
    const dirs = state.workspace?.dirs || {};
    return ["control1", "control2", "control3", "result"].map((key) => dirs[key] || "").join("|");
  }

  function readStoredListViewState() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEYS.selectedItemState);
      const value = raw ? JSON.parse(raw) : null;
      return value && typeof value === "object" ? value : null;
    } catch (_) {
      return null;
    }
  }

  function saveListViewState() {
    window.localStorage.setItem(STORAGE_KEYS.selectedItemState, JSON.stringify({
      workspace_key: workspaceSelectionKey(),
      name: state.selectedName || "",
      panel: activeListPanelId(),
      folder_filter: state.itemFolderFilter || "",
      secondary_folder_filter: state.secondaryItemFolderFilter || "",
    }));
  }

  function clearListViewState() {
    window.localStorage.removeItem(STORAGE_KEYS.selectedItemState);
  }

  function storedListViewStateForActiveWorkspace() {
    const value = readStoredListViewState();
    if (!value) return null;
    const storedKey = `${value.workspace_key || ""}`;
    const currentKey = workspaceSelectionKey();
    if (storedKey && currentKey && storedKey !== currentKey) return null;
    return {
      name: `${value.name || ""}`,
      panel: value.panel === "secondary" && state.splitListOpen ? "secondary" : "primary",
      folderFilter: `${value.folder_filter || ""}`,
      secondaryFolderFilter: `${value.secondary_folder_filter || ""}`,
    };
  }

  function candidateNameForPanel(panelId, preferredName = "", fallbackIndex = 0) {
    const items = panelVisibleItems(panelId);
    if (!items.length) return "";
    if (preferredName && items.some((item) => item.name === preferredName)) return preferredName;
    const nextIndex = Math.max(0, Math.min(items.length - 1, fallbackIndex));
    return items[nextIndex]?.name || "";
  }

  function nextNameAfterRemoving(panelId, removedNames = []) {
    const removed = new Set((Array.isArray(removedNames) ? removedNames : [removedNames]).filter(Boolean));
    const before = panelVisibleItems(panelId).map((item) => item.name);
    const firstRemovedIndex = before.findIndex((name) => removed.has(name));
    const fallbackIndex = firstRemovedIndex >= 0 ? firstRemovedIndex : before.findIndex((name) => name === state.selectedName);
    return () => candidateNameForPanel(panelId, "", Math.max(0, fallbackIndex));
  }

  async function selectAfterListMutation(panelId, preferredName = "", fallbackIndex = 0) {
    const nextName = candidateNameForPanel(panelId, preferredName, fallbackIndex);
    if (nextName) {
      await selectItem(nextName, true, { skipDirtyCheck: true, panelId });
      return;
    }
    state.selectedName = "";
    if (panelId === "secondary") state.secondarySelectedName = "";
    else state.primarySelectedName = "";
    state.currentItem = null;
    clearListViewState();
    setCaptionEditorText("", { markSaved: true });
    renderItemList();
    renderViewer();
    renderTags();
    renderGlobalTags();
    renderSelectionSummary();
  }

  function setPanelThumbMode(panelId, value) {
    const nextMode = normalizeThumbMode(value);
    if (panelId === "secondary") state.secondaryListThumbMode = nextMode;
    else state.listThumbMode = nextMode;
  }

  function syncSplitListUi() {
    const listCard = refs.listPanelShell?.closest(".list-card");
    const isOpen = Boolean(state.splitListOpen);
    animateListHeaderControls();
    if (listCard) {
      if (splitListRenderTimer) {
        window.clearTimeout(splitListRenderTimer);
        splitListRenderTimer = 0;
      }
      if (isOpen) {
        if (!listCard.classList.contains("split-rendered")) {
          const shellRect = refs.listPanelShell?.getBoundingClientRect();
          const cardRect = listCard.getBoundingClientRect();
          const workbenchLayout = listCard.closest(".workbench-layout");
          if (shellRect?.width) {
            const shellTargetWidth = shellRect.width * 2 + 1 + SPLIT_LIST_GAP * 2;
            listCard.style.setProperty("--split-list-gap", `${SPLIT_LIST_GAP}px`);
            listCard.style.setProperty("--split-list-panel-width", `${shellRect.width}px`);
            listCard.style.setProperty("--split-list-shell-target-width", `${shellTargetWidth}px`);
            if (cardRect?.width) {
              const cardInlinePadding = Math.max(0, cardRect.width - shellRect.width);
              workbenchLayout?.style.setProperty("--split-list-card-width", `${cardRect.width}px`);
              workbenchLayout?.style.setProperty("--split-list-card-target-width", `${shellTargetWidth + cardInlinePadding}px`);
            }
          } else if (cardRect?.width) {
            workbenchLayout?.style.setProperty("--split-list-card-width", `${cardRect.width}px`);
            workbenchLayout?.style.setProperty("--split-list-card-target-width", `${cardRect.width * 2 - 13}px`);
          }
        }
        if (!listCard.classList.contains("split-rendered")) {
          listCard.classList.add("split-rendered");
        }
        if (!listCard.classList.contains("split-open")) {
          window.requestAnimationFrame(() => {
            if (state.splitListOpen) listCard.classList.add("split-open");
          });
        }
      } else if (listCard.classList.contains("split-rendered") || listCard.classList.contains("split-open")) {
        listCard.classList.remove("split-open");
        splitListRenderTimer = window.setTimeout(() => {
          if (!state.splitListOpen) {
            animateListHeaderControls();
            listCard.classList.remove("split-rendered");
          }
          splitListRenderTimer = 0;
        }, SPLIT_LIST_ANIMATION_MS);
      }
    }
    if (refs.secondaryListPanel) {
      refs.secondaryListPanel.setAttribute("aria-hidden", String(!isOpen));
    }
    if (refs.toggleSplitListBtn) {
      refs.toggleSplitListBtn.innerHTML = isOpen ? SPLIT_LIST_EXPANDED_ICON : SPLIT_LIST_COLLAPSED_ICON;
      refs.toggleSplitListBtn.setAttribute("aria-pressed", String(isOpen));
      refs.toggleSplitListBtn.setAttribute("aria-label", isOpen ? "收起双栏缩略图列表" : "展开双栏缩略图列表");
      refs.toggleSplitListBtn.title = isOpen ? "收起双栏缩略图列表" : "展开双栏缩略图列表";
    }
  }

  function currentIssueCount() {
    return state.items.reduce((total, item) => {
      const hasMissingControl = activeControlRoles().some((role) => !item.exists?.[role]);
      const hasIssue = hasMissingControl || !item.exists?.result || !item.exists?.txt || Boolean(item.flags?.resolution_mismatch);
      return total + (hasIssue ? 1 : 0);
    }, 0);
  }

  function roleImageCount(role) {
    return state.items.reduce((total, item) => total + (item.exists?.[role] ? 1 : 0), 0);
  }

  function controlImageCount() {
    return activeControlRoles().reduce((total, role) => total + roleImageCount(role), 0);
  }

  function currentProjectLabel() {
    if (state.currentProjectName) return state.currentProjectName;
    if (state.workspace?.project_name) return state.workspace.project_name;
    return "未加载项目";
  }

  function imageVersionForItem(item, role) {
    return item?.image_versions?.[role] || "";
  }

  function imageUrl(role, name, thumb = false, width = 320, height = 220, version = "") {
    const refresh = String(version || state.imageRefreshToken || 0);
    return resolveApiUrl("api/image", {
      role,
      name,
      workspace: state.workspace?.workspace_key || String(state.workspaceImageVersion || 0),
      ...(thumb
        ? {
            thumb: "1",
            width: String(width),
            height: String(height),
            refresh,
          }
        : {
            refresh,
          }),
    }).toString();
  }

  function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
  }

  function updateCachedPanelItem(name, updater) {
    for (const panelId of ["primary", "secondary"]) {
      const items = panelItems(panelId);
      const index = items.findIndex((item) => item.name === name);
      if (index < 0) continue;
      items[index] = updater({ ...items[index] });
    }
  }

  function markCachedItemRoleExists(name, role, item = null) {
    if (!name || !role) return;
    updateCachedPanelItem(name, (cached) => ({
      ...cached,
      ...(item || {}),
      exists: { ...(cached.exists || {}), ...(item?.exists || {}), [role]: true },
      resolution: { ...(cached.resolution || {}), ...(item?.resolution || {}) },
      flags: { ...(cached.flags || {}), ...(item?.flags || {}) },
      image_versions: { ...(cached.image_versions || {}), ...(item?.image_versions || {}) },
    }));
  }

  function cachedItemByName(name) {
    return panelItems("primary").find((entry) => entry.name === name)
      || panelItems("secondary").find((entry) => entry.name === name)
      || (state.currentItem?.name === name ? state.currentItem : null);
  }

  function itemRoleExists(name, role, node = null) {
    return Boolean(
      cachedItemByName(name)?.exists?.[role]
      || node?.dataset?.loaded === "1"
      || node?.classList?.contains("loaded")
    );
  }

  function mergeCachedItem(name, item = null) {
    if (!name || !item) return;
    updateCachedPanelItem(name, (cached) => ({
      ...cached,
      ...item,
      exists: { ...(cached.exists || {}), ...(item.exists || {}) },
      resolution: { ...(cached.resolution || {}), ...(item.resolution || {}) },
      flags: { ...(cached.flags || {}), ...(item.flags || {}) },
      image_versions: { ...(cached.image_versions || {}), ...(item.image_versions || {}) },
    }));
  }

  function createItemThumbs(item, panelId = "primary") {
    const thumbRoles = thumbRolesForMode(panelThumbMode(panelId));
    const thumbs = document.createElement("div");
    thumbs.className = thumbRoles.length > 1 ? "item-thumb-grid" : "item-thumb-single";
    thumbs.style.setProperty("--thumb-count", String(thumbRoles.length));
    for (const role of thumbRoles) {
      if (item.exists?.[role]) {
        thumbs.appendChild(createItemThumbSlot(item, role));
      } else {
        thumbs.appendChild(
          canReplaceItemImageRole(role)
            ? createItemControlDropSlot(item, role)
            : (() => {
                const placeholder = document.createElement("div");
                placeholder.className = "item-thumb-empty";
                placeholder.textContent = `无${(ROLE_LABELS[role] || role).replace(/\s+/g, "")}`;
                return placeholder;
              })(),
        );
      }
    }
    return thumbs;
  }

  function repaintRenderedItemCards(name, item = null) {
    if (!name) return;
    const current = item || cachedItemByName(name);
    if (!current) return;
    const selector = `.item-card[data-name="${cssEscape(name)}"]`;
    for (const card of document.querySelectorAll(selector)) {
      const panelId = card.dataset.panelId || "primary";
      const oldThumbs = card.querySelector(".item-thumb-grid, .item-thumb-single");
      if (!oldThumbs) continue;
      oldThumbs.replaceWith(createItemThumbs(current, panelId));
    }
  }

  function refreshRenderedItemThumbs(name, item = null) {
    repaintRenderedItemCards(name, item);
  }

  function itemDragPayload(event) {
    const sourceName = event.dataTransfer?.getData(ITEM_DRAG_TYPE) || itemDragSource?.name || "";
    const viewerRole = event.dataTransfer?.getData(VIEWER_ROLE_DRAG_TYPE) || "";
    const sourceRole = event.dataTransfer?.getData(ITEM_ROLE_DRAG_TYPE) || itemDragSource?.role || viewerRole || "";
    if (!sourceName && viewerRole && state.currentItem?.name) {
      return { sourceName: state.currentItem.name, sourceRole };
    }
    return { sourceName, sourceRole };
  }

  function createItemThumbSlot(item, role) {
    const slot = document.createElement("div");
    slot.className = "item-thumb-lazy item-thumb-drop loaded";
    slot.dataset.src = imageUrl(role, item.name, true, 192, 156, imageVersionForItem(item, role));
    slot.dataset.name = item.name;
    slot.dataset.role = role;
    slot.dataset.dropName = item.name;
    slot.dataset.dropRole = role;
    slot.dataset.loaded = "1";
    slot.draggable = true;
    slot.title = ROLE_LABELS[role] || role;
    const img = document.createElement("img");
    img.className = "item-thumb";
    img.src = slot.dataset.src;
    img.alt = "";
    img.title = slot.title || "";
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    img.addEventListener("error", () => {
      slot.replaceChildren();
      slot.classList.remove("loaded");
      const placeholder = document.createElement("div");
      placeholder.className = "item-thumb-empty";
      placeholder.textContent = "缩略图加载失败";
      slot.appendChild(placeholder);
    }, { once: true });
    slot.appendChild(img);
    slot.addEventListener("dragstart", (event) => {
      event.stopPropagation();
      setNativeDragFeedbackActive(true);
      event.dataTransfer?.setData(ITEM_DRAG_TYPE, item.name);
      event.dataTransfer?.setData(ITEM_ROLE_DRAG_TYPE, role);
      event.dataTransfer?.setData("application/x-vds-item-names", item.name);
      event.dataTransfer?.setData("text/plain", item.name);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
      itemDragSource = { name: item.name, role };
      slot.closest(".item-card")?.classList.add("dragging");
    });
    slot.addEventListener("dragend", () => {
      setNativeDragFeedbackActive(false);
      itemDragSource = null;
      slot.closest(".item-card")?.classList.remove("dragging");
      document.querySelectorAll(".item-card.drag-over, .folder-chip.drag-over, .item-thumb-drop.drag-over").forEach((node) => {
        node.classList.remove("drag-over");
      });
      clearViewerRoleDragClasses();
    });
    bindItemControlDropTarget(slot, item, role);
    return slot;
  }

  function canDropItemOnControlRole(role) {
    const roleIndex = ["control1", "control2", "control3"].indexOf(role);
    return roleIndex >= 0 && activeControlCount() >= roleIndex + 1;
  }

  function canReplaceItemImageRole(role) {
    return role === "result" || canDropItemOnControlRole(role);
  }

  function droppedImageFile(dataTransfer) {
    const files = Array.from(dataTransfer?.files || []);
    const itemFiles = Array.from(dataTransfer?.items || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);
    return [...files, ...itemFiles].find((entry) => (
      entry.type.startsWith("image/")
      || /\.(avif|bmp|gif|jpe?g|png|tiff?|webp|jfif|heic|heif)$/i.test(entry.name)
    ));
  }

  function droppedImageFiles(dataTransfer) {
    const files = Array.from(dataTransfer?.files || []);
    const itemFiles = Array.from(dataTransfer?.items || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);
    return [...files, ...itemFiles].filter((entry, index, list) => {
      const key = `${entry.name || ""}::${entry.size || 0}::${entry.lastModified || 0}`;
      return (entry.type.startsWith("image/")
        || /\.(avif|bmp|gif|jpe?g|png|tiff?|webp|jfif|heic|heif)$/i.test(entry.name))
        && list.findIndex((candidate) => `${candidate.name || ""}::${candidate.size || 0}::${candidate.lastModified || 0}` === key) === index;
    });
  }

  function dragEventHasControlImagePayload(event) {
    const types = Array.from(event.dataTransfer?.types || []);
    return Boolean(itemDragSource?.name)
      || types.includes(ITEM_DRAG_TYPE)
      || types.includes(VIEWER_ROLE_DRAG_TYPE)
      || droppedImageFiles(event.dataTransfer).length === 1;
  }

  function dragEventHasFilePayload(event) {
    const types = Array.from(event.dataTransfer?.types || []);
    return types.includes("Files")
      || types.includes("text/uri-list")
      || types.includes("public.file-url")
      || types.includes("application/x-moz-file")
      || Array.from(event.dataTransfer?.items || []).some((item) => item.kind === "file");
  }

  function clearItemListDropClasses() {
    for (const panel of listPanels()) {
      panel.itemList?.classList.remove("result-drop-over");
    }
  }

  function bindDocumentFileDropGuard() {
    if (documentFileDropGuardBound) return;
    documentFileDropGuardBound = true;
    const guard = (event) => {
      if (!dragEventHasFilePayload(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    document.addEventListener("dragover", guard, true);
    document.addEventListener("drop", guard, true);
    window.addEventListener("dragover", guard, true);
    window.addEventListener("drop", guard, true);
  }

  function bindItemControlDropTarget(target, item, role) {
    if (!target || !item || !canReplaceItemImageRole(role)) return;
    target.dataset.dropRole = role;
    target.dataset.dropName = item.name;
    target.title = `拖入图片交换或设置${ROLE_LABELS[role] || role}`;
    target.addEventListener("dragover", (event) => {
      if (!dragEventHasControlImagePayload(event)) return;
      event.preventDefault();
      target.classList.add("drag-over");
      if (event.dataTransfer) {
        const hasInternalImage = Boolean(itemDragSource?.name)
          || Array.from(event.dataTransfer.types || []).includes(ITEM_DRAG_TYPE)
          || Array.from(event.dataTransfer.types || []).includes(VIEWER_ROLE_DRAG_TYPE);
        event.dataTransfer.dropEffect = hasInternalImage && itemRoleExists(item.name, role, target) ? "move" : "copy";
      }
    });
    target.addEventListener("dragleave", (event) => {
      if (target.contains(event.relatedTarget)) return;
      target.classList.remove("drag-over");
    });
    target.addEventListener("drop", (event) => {
      const { sourceName, sourceRole } = itemDragPayload(event);
      const files = droppedImageFiles(event.dataTransfer);
      const file = files[0];
      if (!sourceName && !file) return;
      if (!sourceName && files.length !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      target.classList.remove("drag-over");
      if (sourceName) {
        const targetExists = itemRoleExists(item.name, role, target);
        const normalizedSourceRole = sourceRole || "result";
        const action = targetExists
          ? swapItemImages(sourceName, normalizedSourceRole, item.name, role)
          : assignItemControlImage(sourceName, item.name, role, normalizedSourceRole);
        action.catch(showError || console.error);
      } else {
        uploadControlImageFile(file, item.name, role).catch(showError || console.error);
      }
    });
  }

  function createItemControlDropSlot(item, role) {
    const placeholder = document.createElement("div");
    placeholder.className = "item-thumb-empty item-thumb-drop";
    placeholder.textContent = (ROLE_LABELS[role] || role).replace(/\s+/g, "");
    bindItemControlDropTarget(placeholder, item, role);
    return placeholder;
  }

  function activeControlCount() {
    const rawCount = state.workspace?.settings?.control_count ?? refs.controlCount?.value ?? 1;
    const count = Number(rawCount);
    return Math.max(0, Math.min(3, Number.isFinite(count) ? count : 1));
  }

  function formControlCount() {
    const count = Number(refs.controlCount?.value ?? 1);
    return Math.max(0, Math.min(3, Number.isFinite(count) ? count : 1));
  }

  function activeControlRoles() {
    return ["control1", "control2", "control3"].slice(0, activeControlCount());
  }

  function renderWorkspaceSummary() {
    const counts = state.workspace?.counts;
    if (!counts) {
      refs.workspaceStat.textContent = "未加载项目";
      if (refs.metricAll) refs.metricAll.textContent = "0";
      if (refs.metricControlImages) refs.metricControlImages.textContent = "0";
      if (refs.metricResultImages) refs.metricResultImages.textContent = "0";
      refs.metricTxt.textContent = "0";
      if (refs.metricIssues) refs.metricIssues.textContent = "0";
      refs.metricFiltered.textContent = "0";
      return;
    }

    refs.workspaceStat.textContent = currentProjectLabel();
    if (refs.metricAll) refs.metricAll.textContent = `${counts.all || 0}`;
    if (refs.metricControlImages) refs.metricControlImages.textContent = `${controlImageCount()}`;
    if (refs.metricResultImages) refs.metricResultImages.textContent = `${roleImageCount("result")}`;
    refs.metricTxt.textContent = `${counts.txt || 0}`;
    if (refs.metricIssues) refs.metricIssues.textContent = `${currentIssueCount()}`;
    refs.metricFiltered.textContent = `${state.items.length || 0}`;
  }

  function renderFilterSummary() {
    const selects = [
      ["primary", refs.listThumbModeSelect],
      ["secondary", refs.secondaryListThumbModeSelect],
    ];
    for (const [panelId, select] of selects.filter(([, select]) => Boolean(select))) {
      const currentValue = normalizeThumbMode(panelThumbMode(panelId));
      if (currentValue !== panelThumbMode(panelId)) {
        setPanelThumbMode(panelId, currentValue);
        saveStored(panelId === "secondary" ? STORAGE_KEYS.secondaryListThumbMode : STORAGE_KEYS.listThumbMode, currentValue);
      }
      const controlOptions = activeControlRoles().map((role, index) => new Option(`仅控制图${index + 1}`, role));
      select.replaceChildren();
      if (activeControlCount() > 0) {
        select.append(new Option("控制图与结果图", "combined"));
      }
      select.append(new Option("仅结果图", "result"), ...controlOptions);
      select.value = currentValue;
    }
  }

  function renderFilters() {
    syncSplitListUi();
    const groups = [
      ["primary", refs.filterGroup],
      ["secondary", refs.secondaryFilterGroup],
    ];
    for (const [panelId, group] of groups.filter(([, group]) => Boolean(group))) {
      group.querySelectorAll("button").forEach((button) => {
        button.classList.toggle("active", button.dataset.filter === panelFilter(panelId));
      });
    }
    renderFilterSummary();
  }

  function itemFlag(item) {
    const flags = [];
    if (!item.exists.result) flags.push(["缺结果", "danger"]);
    for (const role of activeControlRoles()) {
      if (!item.exists[role]) flags.push([`缺${ROLE_LABELS[role]}`, "warn"]);
    }
    if (!item.exists.txt) flags.push(["缺 TXT", "warn"]);
    if (item.flags.resolution_mismatch) flags.push(["分辨率异", "warn"]);
    if (!flags.length) flags.push(["正常", "ok"]);
    return flags;
  }

  function displayItemName(name) {
    return `${name || ""}`.replace(/\\/g, "/");
  }

  function displayItemBasename(name) {
    const parts = displayItemName(name).split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }

  function displayItemListName(name, panelId = "primary") {
    const currentFolder = normalizeFolderPath(effectivePanelFolderFilter(panelId));
    const fullName = displayItemName(name);
    if (!currentFolder) return fullName;
    const currentPrefix = `${currentFolder}/`;
    if (!fullName.startsWith(currentPrefix)) return displayItemBasename(name);
    const relative = fullName.slice(currentPrefix.length);
    return relative || displayItemBasename(name);
  }

  function appendHighlightedText(parent, text, query) {
    const value = `${text ?? ""}`;
    const needle = `${query ?? ""}`.trim();
    if (!needle) {
      parent.textContent = value;
      return;
    }
    const lowerValue = value.toLowerCase();
    const lowerNeedle = needle.toLowerCase();
    let index = 0;
    let matchIndex = lowerValue.indexOf(lowerNeedle);
    if (matchIndex < 0) {
      parent.textContent = value;
      return;
    }
    parent.textContent = "";
    while (matchIndex >= 0) {
      if (matchIndex > index) {
        parent.appendChild(document.createTextNode(value.slice(index, matchIndex)));
      }
      const mark = document.createElement("span");
      mark.className = "search-hit";
      mark.textContent = value.slice(matchIndex, matchIndex + needle.length);
      parent.appendChild(mark);
      index = matchIndex + needle.length;
      matchIndex = lowerValue.indexOf(lowerNeedle, index);
    }
    if (index < value.length) {
      parent.appendChild(document.createTextNode(value.slice(index)));
    }
  }

  function itemFolder(name) {
    const parts = displayItemName(name).split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
  }

  function itemFolders(panelId = "primary") {
    const workspaceFolders = Array.isArray(state.workspace?.folders) ? state.workspace.folders : [];
    const folders = new Set(workspaceFolders.filter(Boolean));
    for (const item of panelItems(panelId)) {
      const parts = itemFolder(item.name).split("/").filter(Boolean);
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        folders.add(current);
      }
    }
    return [...folders]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  }

  function normalizeFolderPath(folder) {
    return `${folder || ""}`.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  }

  function folderParentPath(folder) {
    const parts = normalizeFolderPath(folder).split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
  }

  function filteredItems(panelId = "primary") {
    const folder = effectivePanelFolderFilter(panelId);
    const searchActive = Boolean(panelSegmentQuery(panelId).trim());
    const mode = normalizeThumbMode(panelThumbMode(panelId));
    const items = panelItems(panelId).filter((item) => (
      searchActive || !/^(?:result|control[1-3])$/.test(mode) || item.exists?.[mode]
    ));
    if (!folder) return [...items];
    const prefix = `${folder}/`;
    return items.filter((item) => {
      const itemPath = itemFolder(item.name);
      return itemPath === folder || itemPath.startsWith(prefix);
    });
  }

  function syncWorkspaceFolders() {
    const folders = new Set(Array.isArray(state.workspace?.folders) ? state.workspace.folders : []);
    for (const panelId of ["primary", "secondary"]) {
      if (panelId === "secondary" && !state.splitListOpen) continue;
      for (const item of panelItems(panelId)) {
        const folder = itemFolder(item.name);
        if (folder) folders.add(folder);
      }
    }
    state.workspace = { ...(state.workspace || {}), folders: [...folders].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })) };
  }

  function itemDragRoleForPanel(item, panelId = "primary") {
    const visibleRoles = thumbRolesForMode(panelThumbMode(panelId));
    return visibleRoles.find((role) => item.exists?.[role]) || "";
  }

  function itemDragNamesForPanel(item, panelId = "primary") {
    const selection = selectedBatchNames(panelId);
    if (selection.length && selection.includes(item.name)) return selection;
    return [item.name];
  }

  function batchSelection() {
    if (!(state.batchSelectedNames instanceof Set)) state.batchSelectedNames = new Set();
    return state.batchSelectedNames;
  }

  function batchSelectionPanelId() {
    return state.splitListOpen && state.batchSelectionPanel === "secondary" ? "secondary" : "primary";
  }

  function setBatchSelectionPanel(panelId = activeListPanelId(), options = {}) {
    const nextPanel = panelId === "secondary" && state.splitListOpen ? "secondary" : "primary";
    if (options.clearOnChange && state.batchSelectionPanel && state.batchSelectionPanel !== nextPanel) {
      batchSelection().clear();
      state.batchSelectionAnchor = "";
    }
    state.batchSelectionPanel = nextPanel;
  }

  function visibleItemNameSet() {
    return new Set(panelVisibleItems(batchSelectionPanelId()).map((item) => item.name));
  }

  function selectedBatchNames(panelId = activeListPanelId()) {
    if (panelId !== batchSelectionPanelId()) return [];
    const visibleNames = visibleItemNameSet();
    return [...batchSelection()].filter((name) => visibleNames.has(name));
  }

  function clearBatchSelection() {
    batchSelection().clear();
    setBatchSelectionPanel();
    state.batchSelectionAnchor = "";
  }

  function toggleBatchSelection(name) {
    if (!name) return;
    const selection = batchSelection();
    if (selection.has(name)) selection.delete(name);
    else selection.add(name);
  }

  function addBatchSelectionRange(targetName, panelId = activeListPanelId()) {
    setBatchSelectionPanel(panelId, { clearOnChange: true });
    const names = panelVisibleItems(panelId).map((item) => item.name);
    if (!names.length || !targetName) return 0;
    const anchorName = names.includes(state.batchSelectionAnchor)
      ? state.batchSelectionAnchor
      : names.includes(state.selectedName)
        ? state.selectedName
        : selectedBatchNames()[0] || targetName;
    const start = names.indexOf(anchorName);
    const end = names.indexOf(targetName);
    if (start < 0 || end < 0) {
      batchSelection().add(targetName);
      state.batchSelectionAnchor = targetName;
      return selectedBatchNames().length;
    }
    const [from, to] = start < end ? [start, end] : [end, start];
    for (const name of names.slice(from, to + 1)) {
      batchSelection().add(name);
    }
    state.batchSelectionAnchor = targetName;
    return selectedBatchNames().length;
  }

  function pruneBatchSelection() {
    const visibleNames = visibleItemNameSet();
    for (const name of [...batchSelection()]) {
      if (!visibleNames.has(name)) batchSelection().delete(name);
    }
    if (state.batchSelectionAnchor && !visibleNames.has(state.batchSelectionAnchor)) {
      state.batchSelectionAnchor = "";
    }
  }

  function syncBatchSelectionPanelAvailability() {
    if (state.splitListOpen || state.batchSelectionPanel !== "secondary") return;
    batchSelection().clear();
    state.batchSelectionPanel = "primary";
    state.batchSelectionAnchor = "";
  }

  function renderFolderFilters(panel) {
    if (!panel?.folderFilters) return;
    const panelId = panel.id || "primary";
    const activeFolder = effectivePanelFolderFilter(panelId);
    const folders = itemFolders(panelId);
    if (activeFolder && !folders.includes(activeFolder)) {
      setPanelFolderFilter(panelId, "");
    }
    panel.folderFilters.textContent = "";

    const allButton = document.createElement("button");
    allButton.type = "button";
    allButton.className = `folder-filter-chip all${activeFolder ? "" : " active"}`;
    allButton.textContent = "全部";
    allButton.addEventListener("click", () => {
      setPanelFolderFilter(panelId, "");
      renderItemList();
      const next = panelVisibleItems(panelId)[0];
      if (next && !panelVisibleItems(panelId).some((item) => item.name === state.selectedName)) {
        selectItem(next.name, false, { panelId }).catch(showError || console.error);
      }
    });
    allButton.addEventListener("dragover", (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes(ITEM_DRAG_TYPE)) return;
      event.preventDefault();
      allButton.classList.add("drag-over");
      event.dataTransfer.dropEffect = "move";
    });
    allButton.addEventListener("dragleave", () => {
      allButton.classList.remove("drag-over");
    });
    allButton.addEventListener("drop", (event) => {
      const name = event.dataTransfer?.getData(ITEM_DRAG_TYPE) || "";
      const names = event.dataTransfer?.getData("application/x-vds-item-names") || "";
      const payloadNames = names ? names.split("\n").map((value) => value.trim()).filter(Boolean) : [];
      const targetNames = payloadNames.length ? payloadNames : (name ? [name] : []);
      if (!targetNames.length) return;
      event.preventDefault();
      event.stopPropagation();
      allButton.classList.remove("drag-over");
      moveItemsToFolder(targetNames, "").catch(showError || console.error);
    });
    panel.folderFilters.appendChild(allButton);

    if (!folders.length) return;

    const group = document.createElement("div");
    group.className = "folder-filter-group";
    for (const folder of folders) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `folder-filter-chip${activeFolder === folder ? " active" : ""}`;
      button.dataset.folder = folder;
      button.textContent = folder;
      button.addEventListener("click", () => {
        setPanelFolderFilter(panelId, folder);
        renderItemList();
        const next = panelVisibleItems(panelId)[0];
        if (next && !panelVisibleItems(panelId).some((item) => item.name === state.selectedName)) {
          selectItem(next.name, false, { panelId }).catch(showError || console.error);
        }
      });
      button.addEventListener("dragover", (event) => {
        if (!Array.from(event.dataTransfer?.types || []).includes(ITEM_DRAG_TYPE)) return;
        event.preventDefault();
        button.classList.add("drag-over");
        event.dataTransfer.dropEffect = "move";
      });
      button.addEventListener("dragleave", () => {
        button.classList.remove("drag-over");
      });
      button.addEventListener("drop", (event) => {
        const name = event.dataTransfer?.getData(ITEM_DRAG_TYPE) || "";
        const names = event.dataTransfer?.getData("application/x-vds-item-names") || "";
        const payloadNames = names ? names.split("\n").map((value) => value.trim()).filter(Boolean) : [];
        const targetNames = payloadNames.length ? payloadNames : (name ? [name] : []);
        if (!targetNames.length) return;
        event.preventDefault();
        button.classList.remove("drag-over");
        moveItemsToFolder(targetNames, folder).catch(showError || console.error);
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openFolderContextMenu(event, folder, panelId);
      });
      group.appendChild(button);
    }
    panel.folderFilters.appendChild(group);
  }

  function openFolderContextMenu(event, folder, panelId = activeListPanelId()) {
    if (!itemContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    itemContextTarget = { mode: "folder", folder: normalizeFolderPath(folder), panelId };
    configureItemContextMenu("folder");
    positionItemContextMenu(event);
  }

  async function moveItemToFolder(name, folder) {
    if (!name || folder == null) return;
    const targetFolder = normalizeFolderPath(folder);
    if (itemFolder(name) === targetFolder) return;
    if (!(await confirmDiscardCaptionChanges())) return;
    const data = await apiPost("/api/item/move-folder", { name, folder: targetFolder });
    if (data.workspace) applyWorkspaceSummary(data.workspace);
    setPanelFolderFilter(activeListPanelId(), targetFolder);
    setAiStatusLine(targetFolder ? `已移动到子文件夹：${targetFolder}` : "已移动到项目根目录");
    await refreshItems({ skipDirtyCheck: true, suppressSelectionSync: true });
    await selectItem(data.new_name || name, true, { skipDirtyCheck: true, panelId: activeListPanelId() });
  }

  async function moveItemsToFolder(names, folder) {
    const targets = [...new Set(Array.isArray(names) ? names : [names])].filter(Boolean);
    const targetFolder = normalizeFolderPath(folder);
    if (!targets.length || folder == null) return;
    if (targets.includes(state.selectedName) && !(await confirmDiscardCaptionChanges())) return;
    const data = await apiPost("/api/item/move-folder", { names: targets, folder: targetFolder });
    if (data.workspace) applyWorkspaceSummary(data.workspace);
    clearBatchSelection();
    setPanelFilter(activeListPanelId(), panelFilter(activeListPanelId()));
    const moved = Array.isArray(data.moved) ? data.moved : [];
    const skipped = Array.isArray(data.skipped) ? data.skipped : [];
    const duplicateCount = skipped.filter((item) => item.reason === "already_exists").length;
    const notFoundCount = skipped.filter((item) => item.reason === "not_found").length;
    const statusParts = [];
    if (moved.length) statusParts.push(`移动 ${moved.length} 项`);
    if (duplicateCount) statusParts.push(`跳过重复项 ${duplicateCount} 项`);
    if (notFoundCount) statusParts.push(`未找到条目 ${notFoundCount} 项`);
    const location = targetFolder ? `子文件夹：${targetFolder}` : "项目根目录";
    setAiStatusLine(`${location}：${statusParts.join("，") || "没有可移动项目"}`);
    await refreshItems({ skipDirtyCheck: true, suppressSelectionSync: true });
    const nextName = moved[moved.length - 1]?.new_name || "";
    if (nextName) await selectItem(nextName, true, { skipDirtyCheck: true, panelId: activeListPanelId() });
  }

  function closeItemContextMenu(immediate = false) {
    if (!itemContextMenu) return;
    if (itemContextMenu.hidden) {
      itemContextTarget = null;
      return;
    }
    if (itemContextCloseTimer) window.clearTimeout(itemContextCloseTimer);
    itemContextCloseTimer = 0;
    if (immediate) {
      itemContextMenu.hidden = true;
      itemContextMenu.classList.remove("menu-open", "menu-closing");
      itemContextTarget = null;
      return;
    }
    itemContextMenu.classList.remove("menu-open");
    itemContextMenu.classList.add("menu-closing");
    itemContextCloseTimer = window.setTimeout(() => {
      itemContextCloseTimer = 0;
      itemContextMenu.hidden = true;
      itemContextMenu.classList.remove("menu-closing");
      itemContextTarget = null;
    }, 180);
  }

  function positionItemContextMenu(event) {
    if (!itemContextMenu) return;
    document.dispatchEvent(new CustomEvent(EXCLUSIVE_MENU_EVENT, { detail: { source: "item-context" } }));
    if (itemContextCloseTimer) {
      window.clearTimeout(itemContextCloseTimer);
      itemContextCloseTimer = 0;
    }
    itemContextMenu.classList.remove("menu-open", "menu-closing");
    itemContextMenu.hidden = false;
    const rect = itemContextMenu.getBoundingClientRect();
    const padding = 8;
    const left = Math.min(Math.max(padding, event.clientX), window.innerWidth - rect.width - padding);
    const top = Math.min(Math.max(padding, event.clientY), window.innerHeight - rect.height - padding);
    itemContextMenu.style.left = `${Math.round(left)}px`;
    itemContextMenu.style.top = `${Math.round(top)}px`;
    window.requestAnimationFrame(() => {
      itemContextMenu.classList.add("menu-open");
    });
  }

  function configureItemContextMenu(mode, count = 1) {
    if (!itemContextMenu) return;
    itemContextMenu.querySelectorAll("button[data-action]").forEach((button) => {
      const action = button.dataset.action;
      const label = button.querySelector("span");
      if (mode === "batch") {
        button.hidden = !["clone", "trash", "create-folder"].includes(action);
        if (action === "clone" && label) label.textContent = `克隆所选 ${count} 项`;
        if (action === "trash" && label) label.textContent = `删除所选 ${count} 项`;
        if (action === "create-folder" && label) label.textContent = "新建文件夹";
        return;
      }
      if (mode === "folder") {
        button.hidden = !["rename", "trash", "create-folder"].includes(action);
        if (action === "rename" && label) label.textContent = "重命名文件夹";
        if (action === "trash" && label) label.textContent = "删除文件夹";
        if (action === "create-folder" && label) label.textContent = "新建文件夹";
        return;
      }
      button.hidden = false;
      if (action === "clone" && label) label.textContent = "克隆";
      if (action === "trash" && label) label.textContent = "删除";
      if (action === "create-folder" && label) label.textContent = "新建文件夹";
    });
  }

  function openItemContextMenu(event, item, title) {
    if (!itemContextMenu || !item?.name) return;
    event.preventDefault();
    event.stopPropagation();
    const selectedNames = selectedBatchNames();
    if (selectedNames.length > 1) {
      itemContextTarget = { mode: "batch", names: selectedNames };
      configureItemContextMenu("batch", selectedNames.length);
    } else {
      if (selectedNames.length) {
        clearBatchSelection();
        updateItemCardActiveState();
      }
      itemContextTarget = { mode: "single", item, title };
      configureItemContextMenu("single");
    }
    positionItemContextMenu(event);
  }

  async function revealItemInFileManager(item) {
    if (!item?.name) return;
    const data = await apiPost("/api/item/reveal", { name: item.name });
    setAiStatusLine(`已在文件管理器中定位：${data.path || item.name}`);
  }

  async function createFolderFromContext(menuFolder = "") {
    const baseFolder = normalizeFolderPath(menuFolder || panelFolderFilter(activeListPanelId()) || "");
    const defaultName = baseFolder ? `${baseFolder.split("/").pop() || "new_folder"}` : "new_folder";
    const input = await window.appPrompt("输入文件夹名称", defaultName);
    if (!input || !input.trim()) return;
    const raw = input.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    const targetFolder = baseFolder && !raw.includes("/") ? `${baseFolder}/${raw}` : raw;
    const data = await apiPost("/api/item/create-folder", { folder: targetFolder });
    if (data.workspace) applyWorkspaceSummary(data.workspace);
    setAiStatusLine(`已新建文件夹：${data.folder || targetFolder}`);
    await refreshItems({ skipDirtyCheck: true, suppressSelectionSync: true });
  }

  async function renameFolderFromContext(folder) {
    const cleanFolder = normalizeFolderPath(folder);
    if (!cleanFolder) return;
    const parent = folderParentPath(cleanFolder);
    const currentName = cleanFolder.split("/").pop() || cleanFolder;
    const input = await window.appPrompt("重命名文件夹", currentName);
    if (!input || !input.trim()) return;
    const nextName = normalizeFolderPath(input);
    if (!nextName) return;
    const targetFolder = parent ? `${parent}/${nextName}` : nextName;
    const data = await apiPost("/api/item/rename-folder", { folder: cleanFolder, new_folder: targetFolder });
    if (data.workspace) applyWorkspaceSummary(data.workspace);
    const activeFolder = normalizeFolderPath(panelFolderFilter(activeListPanelId()));
    setPanelFolderFilter(activeListPanelId(), activeFolder === cleanFolder ? targetFolder : activeFolder);
    setAiStatusLine(`已重命名文件夹：${cleanFolder} -> ${targetFolder}`);
    await rescanWorkspace();
  }

  async function deleteFolderFromContext(folder) {
    const cleanFolder = normalizeFolderPath(folder);
    if (!cleanFolder) return;
    const ok = await window.appConfirm(`确定删除文件夹「${cleanFolder}」？`, "删除文件夹");
    if (!ok) return;
    const data = await apiPost("/api/item/delete-folder", { folder: cleanFolder });
    if (data.workspace) applyWorkspaceSummary(data.workspace);
    if (normalizeFolderPath(panelFolderFilter(activeListPanelId())) === cleanFolder) setPanelFolderFilter(activeListPanelId(), "");
    setAiStatusLine(`已删除文件夹：${cleanFolder}`);
    await refreshItems({ skipDirtyCheck: true, suppressSelectionSync: true });
  }

  async function cloneItemFiles(item) {
    if (!item?.name) return;
    if (item.name === state.selectedName && !(await confirmDiscardCaptionChanges())) return;
    const data = await apiPost("/api/item/clone", { name: item.name });
    if (data.workspace) applyWorkspaceSummary(data.workspace);
    setAiStatusLine(`已克隆：${displayItemName(item.name)} -> ${displayItemName(data.new_name || "")}`);
    await refreshItems({ skipDirtyCheck: true, suppressSelectionSync: true });
    await selectItem(data.new_name || item.name, true, { skipDirtyCheck: true, panelId: activeListPanelId() });
  }

  async function cloneBatchItems(names) {
    const targets = [...new Set(names || [])].filter(Boolean);
    if (!targets.length) return;
    if (targets.includes(state.selectedName) && !(await confirmDiscardCaptionChanges())) return;
    const created = [];
    for (const name of targets) {
      const data = await apiPost("/api/item/clone", { name });
      if (data.workspace) applyWorkspaceSummary(data.workspace);
      if (data.new_name) created.push(data.new_name);
    }
    clearBatchSelection();
    setAiStatusLine(`已克隆 ${targets.length} 项`);
    await refreshItems({ skipDirtyCheck: true, suppressSelectionSync: true });
    const nextName = created[created.length - 1] || targets[0];
    if (nextName) await selectItem(nextName, true, { skipDirtyCheck: true, panelId: activeListPanelId() });
  }

  async function trashItemFiles(item) {
    if (!item?.name) return;
    if (item.name === state.selectedName && !(await confirmDiscardCaptionChanges())) return;
    const panelId = activeListPanelId();
    const nextName = nextNameAfterRemoving(panelId, [item.name]);
    const ok = await window.appConfirm(`确定删除「${displayItemName(item.name)}」的图像和关联 TXT 吗？`, "删除图片");
    if (!ok) return;
    const data = await apiPost("/api/item/trash", { name: item.name });
    if (data.workspace) applyWorkspaceSummary(data.workspace);
    setAiStatusLine(`已删除：${displayItemName(item.name)}`);
    await refreshItems({ skipDirtyCheck: true, suppressSelectionSync: true });
    await selectAfterListMutation(panelId, nextName());
  }

  async function trashCurrentItem() {
    if (!state.selectedName) return;
    const item = state.currentItem?.name === state.selectedName
      ? state.currentItem
      : panelItems(activeListPanelId()).find((candidate) => candidate.name === state.selectedName);
    if (!item) return;
    await trashItemFiles(item);
  }

  async function trashBatchItems(names) {
    const targets = [...new Set(names || [])].filter(Boolean);
    if (!targets.length) return;
    if (targets.includes(state.selectedName) && !(await confirmDiscardCaptionChanges())) return;
    const panelId = activeListPanelId();
    const nextName = nextNameAfterRemoving(panelId, targets);
    const ok = await window.appConfirm(`确定删除所选 ${targets.length} 项的图像和关联 TXT 吗？`, "批量删除图片");
    if (!ok) return;
    for (const name of targets) {
      const data = await apiPost("/api/item/trash", { name });
      if (data.workspace) applyWorkspaceSummary(data.workspace);
    }
    clearBatchSelection();
    setAiStatusLine(`已删除：${targets.length} 项`);
    await refreshItems({ skipDirtyCheck: true, suppressSelectionSync: true });
    await selectAfterListMutation(panelId, nextName());
  }

  async function trashSelectedOrCurrentItems() {
    const targets = selectedBatchNames();
    if (targets.length > 1) {
      await trashBatchItems(targets);
      return;
    }
    if (targets.length === 1 && targets[0] !== state.selectedName) {
      await trashBatchItems(targets);
      return;
    }
    await trashCurrentItem();
  }

  function ensureItemContextMenuEvents() {
    if (!itemContextMenu || state.itemContextMenuBound) return;
    state.itemContextMenuBound = true;
    itemContextMenu.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button || !itemContextTarget) return;
      const { item, title, names, mode, folder } = itemContextTarget;
      closeItemContextMenu();
      const action = button.dataset.action;
      if (mode === "batch" && action === "clone") {
        cloneBatchItems(names).catch(showError || console.error);
      } else if (mode === "batch" && action === "trash") {
        trashBatchItems(names).catch(showError || console.error);
      } else if (mode === "folder" && action === "rename") {
        renameFolderFromContext(folder).catch(showError || console.error);
      } else if (mode === "folder" && action === "trash") {
        deleteFolderFromContext(folder).catch(showError || console.error);
      } else if (action === "create-folder") {
        createFolderFromContext(folder).catch(showError || console.error);
      } else if (action === "rename") {
        beginInlineItemRename(item, title).catch(showError || console.error);
      } else if (action === "clone") {
        cloneItemFiles(item).catch(showError || console.error);
      } else if (action === "reveal") {
        revealItemInFileManager(item).catch(showError || console.error);
      } else if (action === "trash") {
        trashItemFiles(item).catch(showError || console.error);
      }
    });
    document.addEventListener(EXCLUSIVE_MENU_EVENT, (event) => {
      if (event.detail?.source !== "item-context") closeItemContextMenu(true);
    });
    document.addEventListener("click", (event) => {
      if (event.target.closest("#itemContextMenu")) return;
      closeItemContextMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeItemContextMenu();
      const isSelectAll = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a";
      const activeItems = panelVisibleItems(activeListPanelId());
      if (!isSelectAll || shouldIgnoreListArrowNavigation(event.target) || !activeItems.length) return;
      event.preventDefault();
      clearBatchSelection();
      setBatchSelectionPanel(activeListPanelId());
      activeItems.forEach((item) => batchSelection().add(item.name));
      state.batchSelectionAnchor = activeItems[0]?.name || "";
      renderItemList();
      setAiStatusLine(`已选择当前列表 ${activeItems.length} 项`);
    });
    window.addEventListener("resize", closeItemContextMenu);
    document.addEventListener("scroll", closeItemContextMenu, true);
  }

  function animateItemCardSize(card, mutate) {
    if (!card) {
      mutate();
      return;
    }
    const startHeight = card.getBoundingClientRect().height;
    card._sizeAnimation?.cancel();
    card._sizeAnimation = null;
    card.style.height = "";
    card.style.overflow = "";
    mutate();
    const endHeight = card.getBoundingClientRect().height;
    if (!Number.isFinite(startHeight) || !Number.isFinite(endHeight) || Math.abs(startHeight - endHeight) < 1) {
      return;
    }

    const cleanup = () => {
      if (card._sizeAnimation !== animation) return;
      card._sizeAnimation = null;
      card.style.height = "";
      card.style.overflow = "";
    };

    card.style.overflow = "hidden";
    card.style.height = `${endHeight}px`;
    const animation = card.animate(
      [{ height: `${startHeight}px` }, { height: `${endHeight}px` }],
      ITEM_CARD_SIZE_ANIMATION,
    );
    card._sizeAnimation = animation;
    animation.addEventListener("finish", cleanup, { once: true });
    animation.addEventListener("cancel", cleanup, { once: true });
  }

  async function beginInlineItemRename(item, title) {
    if (!item?.name) return;
    if (title?.querySelector(".item-rename-input")) {
      title.querySelector(".item-rename-input")?.focus();
      return;
    }
    if (!(await confirmDiscardCaptionChanges())) return;
    const currentBase = displayItemBasename(item.name);
    const originalText = displayItemListName(item.name);
    const input = document.createElement("textarea");
    input.className = "item-rename-input";
    input.value = currentBase;
    input.setAttribute("aria-label", "重命名图片名称");
    input.rows = 2;
    const card = title.closest(".item-card");
    animateItemCardSize(card, () => {
      title.textContent = "";
      title.appendChild(input);
      card?.classList.add("renaming");
    });
    input.focus();
    input.select();

    let committed = false;
    const restore = () => {
      animateItemCardSize(title.closest(".item-card"), () => {
        title.closest(".item-card")?.classList.remove("renaming");
        title.textContent = originalText;
      });
    };
    const commit = async () => {
      if (committed) return;
      const cleanBase = input.value.trim();
      if (!cleanBase || cleanBase === currentBase) {
        committed = true;
        restore();
        return;
      }
      if (cleanBase.includes("/") || cleanBase.includes("\\")) {
        setAiStatusLine("重命名只允许修改图片名称，不包含文件夹。");
        input.focus();
        input.select();
        return;
      }
      committed = true;
      input.disabled = true;
      try {
        const data = await apiPost("/api/item/rename", {
          name: item.name,
          new_name: cleanBase,
        });
        if (data.workspace) applyWorkspaceSummary(data.workspace);
        setAiStatusLine(`已重命名：${data.new_name || cleanBase}`);
        await refreshItems({ skipDirtyCheck: true, suppressSelectionSync: true });
        await selectItem(data.new_name || cleanBase, true, { skipDirtyCheck: true });
      } catch (error) {
        committed = false;
        input.disabled = false;
        input.focus();
        input.select();
        throw error;
      }
    };

    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("dblclick", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit().catch(showError || console.error);
      } else if (event.key === "Escape") {
        event.preventDefault();
        committed = true;
        restore();
      }
    });
    input.addEventListener("blur", () => {
      commit().catch(showError || console.error);
    });
  }

  function scrollSelectedItemIntoView(block = "center") {
    if (!state.selectedName) return;
    for (const panel of listPanels()) {
      if (panel.id !== activeListPanelId()) continue;
      const activeCard = panel.itemList.querySelector(`.item-card[data-name="${CSS.escape(state.selectedName)}"]`);
      if (!activeCard) continue;
      if (block === "nearest") {
        const listRect = panel.itemList.getBoundingClientRect();
        const cardRect = activeCard.getBoundingClientRect();
        const clippedTop = cardRect.top < listRect.top;
        const clippedBottom = cardRect.bottom > listRect.bottom;
        if (!clippedTop && !clippedBottom) continue;
        if (clippedTop) {
          panel.itemList.scrollTop -= listRect.top - cardRect.top;
        } else {
          panel.itemList.scrollTop += cardRect.bottom - listRect.bottom;
        }
        continue;
      }
      activeCard.scrollIntoView({ block, inline: "nearest" });
    }
  }

  function updateItemCardActiveState() {
    for (const panel of listPanels()) {
      panel.itemList.querySelectorAll(".item-card").forEach((card) => {
        card.classList.toggle("active", panel.id === activeListPanelId() && card.dataset.name === state.selectedName);
        card.classList.toggle("multi-selected", panel.id === batchSelectionPanelId() && batchSelection().has(card.dataset.name));
      });
    }
  }

  function updateViewerImageFit(img) {
    if (!img) return;
    const stage = img.closest(".image-stage");
    if (!stage || !img.naturalWidth || !img.naturalHeight) return;
    const stageStyle = window.getComputedStyle(stage);
    const horizontalPadding = parseFloat(stageStyle.paddingLeft || "0") + parseFloat(stageStyle.paddingRight || "0");
    const verticalPadding = parseFloat(stageStyle.paddingTop || "0") + parseFloat(stageStyle.paddingBottom || "0");
    const stageWidth = Math.max(0, stage.clientWidth - horizontalPadding);
    const stageHeight = Math.max(0, stage.clientHeight - verticalPadding);
    if (!stageWidth || !stageHeight) return;

    const scale = Math.min(stageWidth / img.naturalWidth, stageHeight / img.naturalHeight);
    img.style.width = `${Math.max(1, Math.floor(img.naturalWidth * scale))}px`;
    img.style.height = `${Math.max(1, Math.floor(img.naturalHeight * scale))}px`;
  }

  function updateAllViewerImageFits() {
    refs.viewerGrid.querySelectorAll(".image-stage img").forEach(updateViewerImageFit);
  }

  function ensureViewerResizeObserver() {
    if (state.viewerResizeObserver || typeof ResizeObserver === "undefined") return;
    state.viewerResizeObserver = new ResizeObserver(() => updateAllViewerImageFits());
    state.viewerResizeObserver.observe(refs.viewerGrid);
  }

  function existingPreviewRoles() {
    const item = state.currentItem;
    if (!item) return [];
    return [...activeControlRoles(), "result"].filter((role) => item.exists?.[role]);
  }

  function visibleViewerRoles() {
    const controlCount = activeControlCount();
    return controlCount === 0
      ? ["result"]
      : state.viewMode === "one"
        ? ["result"]
        : state.viewMode === "two"
          ? ["control1", "result"]
          : state.viewMode === "three"
            ? ["control1", "control2", "result"]
            : ["control1", "control2", "control3", "result"];
  }

  function defaultPreviewRole() {
    const item = state.currentItem;
    if (!item) return "";
    const visibleExisting = visibleViewerRoles().filter((role) => item.exists?.[role]);
    if (!visibleExisting.length) return "";
    return visibleExisting.includes("result") ? "result" : visibleExisting[0];
  }

  function previewRoleLabel(role) {
    return role === "result" ? "结果图" : ROLE_LABELS[role] || role;
  }

  function ensureImagePreviewOverlay() {
    if (imagePreview) return imagePreview;

    const root = document.createElement("div");
    root.className = "image-preview-overlay";
    root.hidden = true;
    root.setAttribute("aria-hidden", "true");
    root.innerHTML = `
      <div class="image-preview-stage" data-preview-stage>
        <img class="image-preview-main" data-preview-main alt="">
      </div>
      <button class="image-preview-close" data-preview-close type="button" aria-label="关闭预览">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" aria-hidden="true"><rect width="256" height="256" fill="none"/><line x1="200" y1="56" x2="56" y2="200" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><line x1="200" y1="200" x2="56" y2="56" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/></svg>
      </button>
      <div class="image-preview-controls" data-preview-controls></div>
      <div class="image-preview-minimap" data-preview-minimap>
        <img data-preview-thumb alt="">
        <span class="image-preview-viewport" data-preview-viewport></span>
      </div>
    `;
    document.body.appendChild(root);

    imagePreview = {
      root,
      stage: root.querySelector("[data-preview-stage]"),
      main: root.querySelector("[data-preview-main]"),
      close: root.querySelector("[data-preview-close]"),
      controls: root.querySelector("[data-preview-controls]"),
      minimap: root.querySelector("[data-preview-minimap]"),
      thumb: root.querySelector("[data-preview-thumb]"),
      viewport: root.querySelector("[data-preview-viewport]"),
      role: "",
      panX: 0,
      panY: 0,
      dragging: null,
      minimapDragging: null,
      minimapMetrics: null,
      minimapHideTimer: 0,
    };

    imagePreview.close.addEventListener("click", closeImagePreview);
    root.addEventListener("click", handleImagePreviewOverlayClick);
    imagePreview.main.addEventListener("load", () => {
      imagePreview.panX = 0;
      imagePreview.panY = 0;
      imagePreview.main.style.opacity = "1";
      imagePreview.thumb.style.opacity = "1";
      updateImagePreviewLayout();
    });
    imagePreview.stage.addEventListener("pointerdown", startImagePreviewDrag);
    imagePreview.viewport.addEventListener("pointerdown", startImagePreviewMinimapDrag);
    imagePreview.minimap.addEventListener("pointerdown", startImagePreviewMinimapDrag);
    window.addEventListener("pointermove", moveImagePreviewDrag);
    window.addEventListener("pointermove", moveImagePreviewMinimapDrag);
    window.addEventListener("pointerup", stopImagePreviewDrag);
    window.addEventListener("pointerup", stopImagePreviewMinimapDrag);
    window.addEventListener("resize", updateImagePreviewLayout);
    document.addEventListener("keydown", (event) => {
      if (!imagePreview || imagePreview.root.hidden) return;
      if (event.key === "Escape") {
        closeImagePreview();
        return;
      }
      if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        navigateImagePreview(event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1).catch(showError || console.error);
      }
    });

    return imagePreview;
  }

  function showImagePreviewMinimap() {
    const preview = ensureImagePreviewOverlay();
    preview.root.classList.add("minimap-visible");
    if (preview.minimapHideTimer) {
      window.clearTimeout(preview.minimapHideTimer);
      preview.minimapHideTimer = 0;
    }
  }

  function scheduleImagePreviewMinimapHide() {
    const preview = imagePreview;
    if (!preview) return;
    if (preview.minimapHideTimer) window.clearTimeout(preview.minimapHideTimer);
    preview.minimapHideTimer = window.setTimeout(() => {
      preview.minimapHideTimer = 0;
      preview.root.classList.remove("minimap-visible");
    }, 3000);
  }

  function openImagePreview(role) {
    const item = state.currentItem;
    if (!item?.exists?.[role]) return;
    const preview = ensureImagePreviewOverlay();
    preview.role = role;
    preview.panX = 0;
    preview.panY = 0;
    preview.root.hidden = false;
    preview.root.setAttribute("aria-hidden", "false");
    document.body.classList.add("image-preview-open");
    renderImagePreviewControls();
    setImagePreviewRole(role);
  }

  function closeImagePreview() {
    if (!imagePreview) return;
    imagePreview.root.hidden = true;
    imagePreview.root.setAttribute("aria-hidden", "true");
    imagePreview.dragging = null;
    imagePreview.main.removeAttribute("src");
    imagePreview.thumb.removeAttribute("src");
    imagePreview.minimapDragging = null;
    imagePreview.minimapMetrics = null;
    if (imagePreview.minimapHideTimer) {
      window.clearTimeout(imagePreview.minimapHideTimer);
      imagePreview.minimapHideTimer = 0;
    }
    imagePreview.root.classList.remove("minimap-visible", "minimap-dragging");
    document.body.classList.remove("image-preview-open");
  }

  function toggleImagePreviewForCurrent() {
    if (imagePreview && !imagePreview.root.hidden) {
      closeImagePreview();
      return true;
    }
    const role = defaultPreviewRole();
    if (!role) return false;
    openImagePreview(role);
    return true;
  }

  async function navigateImagePreview(offset) {
    if (!imagePreview || imagePreview.root.hidden || !offset) return;
    const roles = existingPreviewRoles();
    if (roles.length < 2) return;
    const currentIndex = roles.indexOf(imagePreview.role || "result");
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (baseIndex + offset + roles.length) % roles.length;
    setImagePreviewRole(roles[nextIndex]);
  }

  function renderImagePreviewControls() {
    const preview = ensureImagePreviewOverlay();
    preview.controls.textContent = "";
    preview.controls.classList.add("sliding-toggle-host");
    preview.controls.hidden = activeControlCount() === 0;
    if (preview.controls.hidden) return;
    for (const role of existingPreviewRoles()) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.previewRole = role;
      button.textContent = previewRoleLabel(role);
      button.addEventListener("click", () => setImagePreviewRole(role));
      preview.controls.appendChild(button);
    }
    window.__vdsScheduleSlidingToggleIndicators?.(preview.root);
  }

  function setImagePreviewRole(role) {
    const preview = ensureImagePreviewOverlay();
    const item = state.currentItem;
    if (!item?.exists?.[role]) return;
    preview.role = role;
    preview.panX = 0;
    preview.panY = 0;
    const src = imageUrl(role, item.name, false, 320, 220, imageVersionForItem(item, role));
    preview.main.alt = `${previewRoleLabel(role)} ${item.name}`;
    preview.thumb.alt = `${previewRoleLabel(role)}缩略图`;
    preview.main.style.opacity = "0";
    preview.thumb.style.opacity = "0";
    preview.viewport.hidden = true;
    preview.main.src = src;
    preview.thumb.src = src;
    preview.controls.querySelectorAll("button[data-preview-role]").forEach((button) => {
      button.classList.toggle("active", button.dataset.previewRole === role);
    });
    window.__vdsScheduleSlidingToggleIndicators?.(preview.root);
    updateImagePreviewLayout();
  }

  function previewStageRect() {
    const preview = ensureImagePreviewOverlay();
    const rect = preview.stage.getBoundingClientRect();
    return {
      width: Math.max(0, rect.width),
      height: Math.max(0, rect.height),
    };
  }

  function imagePreviewIsClipped() {
    const preview = ensureImagePreviewOverlay();
    const img = preview.main;
    if (!img.naturalWidth || !img.naturalHeight) return true;
    const stage = previewStageRect();
    return img.naturalWidth > stage.width || img.naturalHeight > stage.height;
  }

  function pointInRect(x, y, rect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function handleImagePreviewOverlayClick(event) {
    const preview = ensureImagePreviewOverlay();
    if (event.target.closest("[data-preview-close], [data-preview-controls], [data-preview-minimap]")) return;

    const stageRect = preview.stage.getBoundingClientRect();
    if (!pointInRect(event.clientX, event.clientY, stageRect)) {
      closeImagePreview();
      return;
    }

    if (imagePreviewIsClipped()) return;

    const imageRect = preview.main.getBoundingClientRect();
    if (!pointInRect(event.clientX, event.clientY, imageRect)) {
      closeImagePreview();
    }
  }

  function clampImagePreviewPan() {
    const preview = ensureImagePreviewOverlay();
    const img = preview.main;
    if (!img.naturalWidth || !img.naturalHeight) return;
    const stage = previewStageRect();
    const overflowX = Math.max(0, img.naturalWidth - stage.width) / 2;
    const overflowY = Math.max(0, img.naturalHeight - stage.height) / 2;
    preview.panX = Math.min(overflowX, Math.max(-overflowX, preview.panX));
    preview.panY = Math.min(overflowY, Math.max(-overflowY, preview.panY));
  }

  function updateImagePreviewMinimapSize() {
    const preview = ensureImagePreviewOverlay();
    const img = preview.main;
    if (!img.naturalWidth || !img.naturalHeight) return;
    const style = window.getComputedStyle(preview.root);
    const maxSize = Number.parseFloat(style.getPropertyValue("--image-preview-minimap-size")) || 150;
    const aspectRatio = img.naturalWidth / img.naturalHeight;
    const width = aspectRatio >= 1 ? maxSize : maxSize * aspectRatio;
    const height = aspectRatio >= 1 ? maxSize / aspectRatio : maxSize;
    preview.minimap.style.width = `${width}px`;
    preview.minimap.style.height = `${height}px`;
  }

  function updateImagePreviewLayout() {
    if (!imagePreview || imagePreview.root.hidden) return;
    const preview = imagePreview;
    const img = preview.main;
    if (!img.naturalWidth || !img.naturalHeight) return;
    clampImagePreviewPan();
    updateImagePreviewMinimapSize();
    img.style.width = `${img.naturalWidth}px`;
    img.style.height = `${img.naturalHeight}px`;
    img.style.transform = `translate(-50%, -50%) translate(${preview.panX}px, ${preview.panY}px)`;
    updateImagePreviewViewport();
  }

  function updateImagePreviewViewport() {
    const preview = ensureImagePreviewOverlay();
    const img = preview.main;
    const mini = preview.minimap.getBoundingClientRect();
    const stage = previewStageRect();
    if (!img.naturalWidth || !img.naturalHeight || !mini.width || !mini.height) {
      preview.viewport.hidden = true;
      return;
    }

    const imageScale = Math.min(mini.width / img.naturalWidth, mini.height / img.naturalHeight);
    const thumbWidth = img.naturalWidth * imageScale;
    const thumbHeight = img.naturalHeight * imageScale;
    const thumbX = (mini.width - thumbWidth) / 2;
    const thumbY = (mini.height - thumbHeight) / 2;
    preview.minimapMetrics = {
      imageScale,
      thumbX,
      thumbY,
      thumbWidth,
      thumbHeight,
      stageWidth: stage.width,
      stageHeight: stage.height,
    };
    const clippedX = img.naturalWidth > stage.width;
    const clippedY = img.naturalHeight > stage.height;
    if (!clippedX && !clippedY) {
      preview.viewport.hidden = true;
      return;
    }

    const visibleWidth = Math.min(stage.width, img.naturalWidth);
    const visibleHeight = Math.min(stage.height, img.naturalHeight);
    const imageLeft = clippedX ? (img.naturalWidth - stage.width) / 2 - preview.panX : 0;
    const imageTop = clippedY ? (img.naturalHeight - stage.height) / 2 - preview.panY : 0;
    preview.viewport.hidden = false;
    preview.viewport.style.left = `${thumbX + imageLeft * imageScale}px`;
    preview.viewport.style.top = `${thumbY + imageTop * imageScale}px`;
    preview.viewport.style.width = `${visibleWidth * imageScale}px`;
    preview.viewport.style.height = `${visibleHeight * imageScale}px`;
  }

  function setPreviewPanFromMinimapPoint(clientX, clientY) {
    const preview = ensureImagePreviewOverlay();
    const img = preview.main;
    const metrics = preview.minimapMetrics;
    if (!img.naturalWidth || !img.naturalHeight || !metrics) return;
    const mini = preview.minimap.getBoundingClientRect();
    const imageX = (clientX - mini.left - metrics.thumbX) / metrics.imageScale;
    const imageY = (clientY - mini.top - metrics.thumbY) / metrics.imageScale;
    const maxPanX = Math.max(0, img.naturalWidth - metrics.stageWidth) / 2;
    const maxPanY = Math.max(0, img.naturalHeight - metrics.stageHeight) / 2;
    preview.panX = maxPanX ? img.naturalWidth / 2 - imageX : 0;
    preview.panY = maxPanY ? img.naturalHeight / 2 - imageY : 0;
    updateImagePreviewLayout();
  }

  function startImagePreviewDrag(event) {
    const preview = ensureImagePreviewOverlay();
    if (event.button !== 0 || !preview.main.naturalWidth) return;
    if (!imagePreviewIsClipped()) return;
    event.preventDefault();
    preview.dragging = {
      x: event.clientX,
      y: event.clientY,
      panX: preview.panX,
      panY: preview.panY,
    };
    showImagePreviewMinimap();
    preview.stage.setPointerCapture?.(event.pointerId);
    preview.root.classList.add("dragging");
  }

  function moveImagePreviewDrag(event) {
    const preview = imagePreview;
    if (!preview?.dragging) return;
    preview.panX = preview.dragging.panX + event.clientX - preview.dragging.x;
    preview.panY = preview.dragging.panY + event.clientY - preview.dragging.y;
    updateImagePreviewLayout();
  }

  function stopImagePreviewDrag() {
    if (!imagePreview?.dragging) return;
    imagePreview.dragging = null;
    imagePreview.root.classList.remove("dragging");
    scheduleImagePreviewMinimapHide();
  }

  function startImagePreviewMinimapDrag(event) {
    const preview = ensureImagePreviewOverlay();
    if (event.button !== 0 || preview.viewport.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    preview.minimapDragging = true;
    showImagePreviewMinimap();
    preview.root.classList.add("minimap-dragging");
    preview.minimap.setPointerCapture?.(event.pointerId);
    setPreviewPanFromMinimapPoint(event.clientX, event.clientY);
  }

  function moveImagePreviewMinimapDrag(event) {
    if (!imagePreview?.minimapDragging) return;
    setPreviewPanFromMinimapPoint(event.clientX, event.clientY);
  }

  function stopImagePreviewMinimapDrag() {
    if (!imagePreview?.minimapDragging) return;
    imagePreview.minimapDragging = null;
    imagePreview.root.classList.remove("minimap-dragging");
    scheduleImagePreviewMinimapHide();
  }

  async function swapItemImages(sourceName, sourceRole, targetName, targetRole) {
    if (
      !sourceName
      || !targetName
      || !IMAGE_ROLES.includes(sourceRole)
      || !canReplaceItemImageRole(targetRole)
      || (sourceName === targetName && sourceRole === targetRole)
    ) {
      return;
    }
    const data = await apiPost("/api/item/swap-images", {
      source_name: sourceName,
      source_role: sourceRole,
      target_name: targetName,
      target_role: targetRole,
    });
    if (data.workspace) applyWorkspaceSummary(data.workspace);
    state.imageRefreshToken = `${Date.now()}-swap-images-${sourceRole}-${targetRole}-${sourceName}-${targetName}`;

    const updated = [
      [sourceName, data.source_item],
      [targetName, data.target_item],
    ];
    const repainted = new Set();
    for (const [name, item] of updated) {
      if (!name || !item || repainted.has(name)) continue;
      repainted.add(name);
      mergeCachedItem(name, item);
      refreshRenderedItemThumbs(name, item);
      if (state.currentItem?.name === name) {
        state.currentItem = item;
      }
    }

    await refreshItems({ skipDirtyCheck: true, suppressSelectionSync: true, includeGlobalSegments: false });
    for (const [name, item] of updated) {
      if (name && item) refreshRenderedItemThumbs(name, item);
    }
    if ([sourceName, targetName].includes(state.selectedName)) {
      await selectItem(state.selectedName, false, { skipDirtyCheck: true, panelId: activeListPanelId() });
    }
    setAiStatusLine?.(
      `已交换 ${sourceName} 的 ${ROLE_LABELS[sourceRole] || sourceRole} 与 ${targetName} 的 ${ROLE_LABELS[targetRole] || targetRole}`
    );
  }

  async function assignItemControlImage(sourceName, targetName, targetRole, sourceRole = "result") {
    sourceRole = sourceRole || "result";
    if (!sourceName || !targetName || !sourceRole || !canReplaceItemImageRole(targetRole)) return;
    if (sourceName === targetName && sourceRole === targetRole) return;
    const data = await apiPost("/api/item/assign-control-image", {
      source_name: sourceName,
      source_role: sourceRole,
      target_name: targetName,
      target_role: targetRole,
    });
    if (data.workspace) applyWorkspaceSummary(data.workspace);
    state.imageRefreshToken = `${Date.now()}-assign-${targetRole}-${targetName}`;
    markCachedItemRoleExists(targetName, targetRole, data.item);
    refreshRenderedItemThumbs(targetName, data.item);
    await refreshItems({ skipDirtyCheck: true, suppressSelectionSync: true, includeGlobalSegments: false });
    refreshRenderedItemThumbs(targetName, data.item);
    if (targetName === state.selectedName) {
      await selectItem(targetName, false, { skipDirtyCheck: true, panelId: activeListPanelId() });
    }
    setAiStatusLine?.(`已把 ${sourceName} 设置为 ${targetName} 的 ${ROLE_LABELS[targetRole] || targetRole}`);
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return window.btoa(binary);
  }

  async function uploadControlImageFile(file, targetName, targetRole) {
    if (!file || !targetName || !canReplaceItemImageRole(targetRole)) return;
    const data = await apiPost("/api/item/upload-control-image", {
      target_name: targetName,
      target_role: targetRole,
      filename: file.name || "dropped.png",
      mime_type: file.type || "",
      data: arrayBufferToBase64(await file.arrayBuffer()),
    });
    if (data.workspace) applyWorkspaceSummary(data.workspace);
    state.imageRefreshToken = `${Date.now()}-upload-${targetRole}-${targetName}`;
    markCachedItemRoleExists(targetName, targetRole, data.item);
    refreshRenderedItemThumbs(targetName, data.item);
    await refreshItems({ skipDirtyCheck: true, suppressSelectionSync: true, includeGlobalSegments: false });
    refreshRenderedItemThumbs(targetName, data.item);
    if (targetName === state.selectedName) {
      await selectItem(targetName, false, { skipDirtyCheck: true, panelId: activeListPanelId() });
    }
    setAiStatusLine?.(`已把 ${file.name || "拖入图片"} 设置为 ${targetName} 的 ${ROLE_LABELS[targetRole] || targetRole}`);
  }

  async function uploadRoleImageFile(file, role = "result", folder = "", options = {}) {
    if (!file) return;
    const { refresh = true } = options || {};
    const targetRole = /^control[1-3]$/.test(role) ? role : "result";
    const data = await apiPost("/api/item/upload-role-image", {
      role: targetRole,
      filename: file.name || "dropped.png",
      mime_type: file.type || "",
      folder: normalizeFolderPath(folder || panelFolderFilter(activeListPanelId()) || ""),
      data: arrayBufferToBase64(await file.arrayBuffer()),
    });
    if (data.workspace) applyWorkspaceSummary(data.workspace);
    state.imageRefreshToken = `${Date.now()}-upload-${targetRole}-${data.name || file.name || "dropped"}`;
    if (refresh) {
      await refreshItems({ skipDirtyCheck: true, suppressSelectionSync: true, includeGlobalSegments: false });
    }
    setAiStatusLine?.(`已添加${ROLE_LABELS[targetRole] || targetRole}：${data.name || file.name || "拖入图片"}`);
    return data;
  }

  function dropRoleForPanel(panelId) {
    const mode = normalizeThumbMode(panelThumbMode(panelId));
    return /^control[1-3]$/.test(mode) ? mode : "result";
  }

  function bindItemListResultDropTarget(panel) {
    const list = panel?.itemList;
    if (!list || list.dataset.resultDropBound === "true") return;
    list.dataset.resultDropBound = "true";
    bindDocumentFileDropGuard();
    list.addEventListener("dragover", (event) => {
      const files = droppedImageFiles(event.dataTransfer);
      if (!files.length) return;
      event.preventDefault();
      list.classList.add("result-drop-over");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    list.addEventListener("dragleave", (event) => {
      if (list.contains(event.relatedTarget)) return;
      list.classList.remove("result-drop-over");
    });
    list.addEventListener("drop", async (event) => {
      const files = droppedImageFiles(event.dataTransfer);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      clearItemListDropClasses();
      const targetRole = dropRoleForPanel(panel.id || "primary");
      const folder = panelFolderFilter(panel.id || "primary");
      const errors = [];
      for (const file of files) {
        try {
          await uploadRoleImageFile(file, targetRole, folder, { refresh: false });
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await refreshItems({ skipDirtyCheck: true, suppressSelectionSync: true, includeGlobalSegments: false });
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) {
        (showError || console.error)(errors[0]);
      }
    });
  }

  function renderItemList() {
    ensureItemContextMenuEvents();
    const scrollTops = new Map(listPanels().map((panel) => [panel.id, panel.itemList.scrollTop]));
    setPanelVisibleItems("primary", filteredItems("primary"));
    setPanelVisibleItems("secondary", filteredItems("secondary"));
    syncBatchSelectionPanelAvailability();
    pruneBatchSelection();
    renderWorkspaceSummary();
    if (refs.metricFiltered) refs.metricFiltered.textContent = `${panelVisibleItems("primary").length || 0}`;

    for (const panel of listPanels()) {
      const panelId = panel.id || "primary";
      const items = panelVisibleItems(panelId);
      const activeFolder = effectivePanelFolderFilter(panelId);
      bindItemListResultDropTarget(panel);
      renderFolderFilters(panel);
      panel.itemList.textContent = "";
      if (panel.listStats) panel.listStats.textContent = activeFolder ? `${items.length}/${panelItems(panelId).length} 项` : `${items.length} 项`;

      for (const item of items) {
        const thumbRoles = thumbRolesForMode(panelThumbMode(panelId));
        const card = document.createElement("article");
        card.className = `item-card${panelId === activeListPanelId() && item.name === state.selectedName ? " active" : ""}${panelId === batchSelectionPanelId() && batchSelection().has(item.name) ? " multi-selected" : ""}${thumbRoles.length > 1 ? " multi-thumb" : ""}`;
        if (thumbRoles.length > 1) {
          card.style.setProperty("--item-card-min-width", `${(thumbRoles.length * 99) + ((thumbRoles.length - 1) * 3) + 10 + 50 + 16}px`);
        }
        card.dataset.name = item.name;
        card.dataset.panelId = panelId;
        card.draggable = true;
        card.title = "双击重命名图片";
        card.addEventListener("dragstart", (event) => {
          if (event.target.closest(".item-rename-input")) {
            event.preventDefault();
            return;
          }
          const dragRole = itemDragRoleForPanel(item, panelId);
          if (!dragRole) {
            event.preventDefault();
            return;
          }
          const names = itemDragNamesForPanel(item, panelId);
          setNativeDragFeedbackActive(true);
          event.dataTransfer?.setData(ITEM_DRAG_TYPE, item.name);
          event.dataTransfer?.setData("application/x-vds-item-names", names.join("\n"));
          event.dataTransfer?.setData(ITEM_ROLE_DRAG_TYPE, dragRole);
          event.dataTransfer?.setData("text/plain", item.name);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
          itemDragSource = { name: item.name, role: dragRole };
          card.classList.add("dragging");
        });
        card.addEventListener("dragend", () => {
          setNativeDragFeedbackActive(false);
          itemDragSource = null;
          card.classList.remove("dragging");
          document.querySelectorAll(".item-card.drag-over, .folder-chip.drag-over, .item-thumb-drop.drag-over").forEach((node) => {
            node.classList.remove("drag-over");
          });
          clearViewerRoleDragClasses();
        });
        card.appendChild(createItemThumbs(item, panelId));

        const right = document.createElement("div");
        right.className = "item-card-main";
        const title = document.createElement("div");
        title.className = "item-title";
        appendHighlightedText(title, displayItemListName(item.name, panelId), panelSearchMode(panelId) === "name" ? panelSegmentQuery(panelId) : "");
        right.appendChild(title);

        const flags = document.createElement("div");
        flags.className = "item-flags";
        for (const [text, cls] of itemFlag(item)) {
          const flag = document.createElement("span");
          flag.className = `flag ${cls}`;
          flag.textContent = text;
          flags.appendChild(flag);
        }
        right.appendChild(flags);
        card.appendChild(right);
        card.addEventListener("click", (event) => {
          if (event.target.closest(".item-rename-input")) return;
          const previousPanelId = activeListPanelId();
          state.selectedPanel = panelId;
          if (event.shiftKey) {
            event.preventDefault();
            const count = addBatchSelectionRange(item.name, panelId);
            updateItemCardActiveState();
            setAiStatusLine(`已选择 ${count} 项`);
            return;
          }
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            setBatchSelectionPanel(panelId, { clearOnChange: true });
            if (!batchSelection().size && previousPanelId === panelId && state.selectedName && state.selectedName !== item.name) {
              batchSelection().add(state.selectedName);
            }
            toggleBatchSelection(item.name);
            state.batchSelectionAnchor = item.name;
            updateItemCardActiveState();
            setAiStatusLine(`已选择 ${selectedBatchNames().length} 项`);
            return;
          }
          if (selectedBatchNames().length) {
            clearBatchSelection();
            updateItemCardActiveState();
          }
          state.batchSelectionAnchor = item.name;
          if (event.detail > 1) {
            event.preventDefault();
            beginInlineItemRename(item, title).catch(showError || console.error);
            return;
          }
          selectItem(item.name, false, { panelId }).catch(showError || console.error);
        });
        card.addEventListener("dblclick", (event) => {
          if (event.target.closest(".item-rename-input")) return;
          event.preventDefault();
          event.stopPropagation();
          beginInlineItemRename(item, title).catch(showError || console.error);
        });
        card.addEventListener("contextmenu", (event) => {
          if (event.target.closest(".item-rename-input")) return;
          state.selectedPanel = panelId;
          openItemContextMenu(event, item, title);
        });
        panel.itemList.appendChild(card);
      }
      panel.itemList.scrollTop = scrollTops.get(panelId) || 0;
    }

    scrollSelectedItemIntoView("nearest");
  }

  function renderSelectionSummary() {
    const item = state.currentItem;
    const activeItems = panelItems(activeListPanelId());
    const selectedIndex = item ? activeItems.findIndex((candidate) => candidate.name === item.name) + 1 : 0;
    refs.focusStat.textContent = selectedIndex > 0 ? `${selectedIndex}/${activeItems.length || 0}` : `0/${activeItems.length || 0}`;
    if (refs.overviewCurrentName) refs.overviewCurrentName.textContent = item ? item.name : "未选择图片";
    if (refs.overviewCurrentMeta) {
      refs.overviewCurrentMeta.textContent = item
        ? [
            `TXT ${item.exists.txt ? "已存在" : "未创建"}`,
            ...activeControlRoles().map((role) => `${ROLE_LABELS[role]} ${item.exists[role] ? "有" : "无"}`),
            `结果图 ${item.exists.result ? "有" : "无"}`,
          ].join(" · ")
        : "加载工作区后，在浏览区选择条目开始编辑。";
    }
  }

  function viewerResolutionSummary(item) {
    if (!item) return "";
    const resultRes = item.resolution.result;
    if (!Array.isArray(resultRes)) return "结果图分辨率: 未读取";

    const comparisons = activeControlRoles()
      .map((role) => ({ role, size: item.resolution[role] }))
      .filter((row) => Array.isArray(row.size));

    if (!comparisons.length) return `结果图分辨率: ${resultRes[0]}×${resultRes[1]}`;

    const mismatches = comparisons.filter(
      (row) => row.size[0] !== resultRes[0] || row.size[1] !== resultRes[1],
    );
    if (!mismatches.length) return `控制图与结果图分辨率一致: ${resultRes[0]}×${resultRes[1]}`;
    return mismatches
      .map((row) => `${ROLE_LABELS[row.role]} ${row.size[0]}×${row.size[1]} 与结果图 ${resultRes[0]}×${resultRes[1]} 不一致`)
      .join(" · ");
  }

  function viewerHasResolutionMismatch(item) {
    if (!item) return false;
    const resultRes = item.resolution?.result;
    if (!Array.isArray(resultRes)) return false;
    return activeControlRoles()
      .map((role) => item.resolution?.[role])
      .filter((size) => Array.isArray(size))
      .some((size) => size[0] !== resultRes[0] || size[1] !== resultRes[1]);
  }

  function renderCurrentMeta(item) {
    refs.currentMeta.textContent = "";
    if (!item) {
      refs.currentMeta.textContent = "选择左侧条目开始浏览。";
      return;
    }

    const statusLine = document.createElement("span");
    statusLine.className = "current-meta-line";
    statusLine.textContent = [
      `TXT: ${item.exists.txt ? "已存在" : "未创建"}`,
      ...activeControlRoles().map((role) => `${ROLE_LABELS[role]}: ${item.exists[role] ? "有" : "无"}`),
      `结果图: ${item.exists.result ? "有" : "无"}`,
    ].join("，");

    const resolutionLine = document.createElement("span");
    resolutionLine.className = "current-meta-line";
    resolutionLine.textContent = viewerResolutionSummary(item);
    resolutionLine.classList.toggle("is-mismatch", viewerHasResolutionMismatch(item));

    refs.currentMeta.append(statusLine, resolutionLine);
  }

  function clearViewerRoleDragClasses() {
    refs.viewerGrid.querySelectorAll(".role-dragging, .role-drop-target").forEach((node) => {
      node.classList.remove("role-dragging", "role-drop-target");
    });
  }

  function canSwapViewerRoles(sourceRole, targetRole) {
    const item = state.currentItem;
    return Boolean(
      item
      && sourceRole
      && targetRole
      && sourceRole !== targetRole
      && item.exists?.[sourceRole]
      && item.exists?.[targetRole],
    );
  }

  function canAssignListItemToViewerControl(targetRole) {
    return Boolean(
      state.currentItem
      && canReplaceItemImageRole(targetRole)
    );
  }

  async function swapViewerItemRoles(sourceRole, targetRole) {
    if (!canSwapViewerRoles(sourceRole, targetRole)) {
      setAiStatusLine("需要两张已存在的图片才能对调控制图/结果图。");
      return;
    }
    if (!(await confirmDiscardCaptionChanges())) return;
    const name = state.currentItem.name;
    const data = await apiPost("/api/item/swap-roles", {
      name,
      source_role: sourceRole,
      target_role: targetRole,
    });
    if (data.workspace) applyWorkspaceSummary(data.workspace);
    if (data.item) {
      state.currentItem = data.item;
      mergeCachedItem(name, data.item);
      refreshRenderedItemThumbs(name, data.item);
    }
    state.imageRefreshToken = `${Date.now()}-swap-${sourceRole}-${targetRole}-${name}`;
    setAiStatusLine(`已对调：${ROLE_LABELS[sourceRole] || sourceRole} <-> ${ROLE_LABELS[targetRole] || targetRole}`);
    await refreshItems({ skipDirtyCheck: true });
    if (data.item) refreshRenderedItemThumbs(name, data.item);
  }

  function ensureViewerRoleDragEvents() {
    if (!refs.viewerGrid || state.viewerRoleDragBound) return;
    state.viewerRoleDragBound = true;
    refs.viewerGrid.addEventListener("dragstart", (event) => {
      const card = event.target.closest(".image-card");
      const role = card?.dataset.role || "";
      if (!card || !state.currentItem?.exists?.[role]) {
        event.preventDefault();
        return;
      }
      setNativeDragFeedbackActive(true);
      event.dataTransfer?.setData(VIEWER_ROLE_DRAG_TYPE, role);
      event.dataTransfer?.setData("text/plain", role);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      state.viewerRoleDragging = role;
      card.classList.add("role-dragging");
    });
    refs.viewerGrid.addEventListener("dragend", () => {
      setNativeDragFeedbackActive(false);
      state.viewerRoleDragging = "";
      clearViewerRoleDragClasses();
    });
    refs.viewerGrid.addEventListener("dragover", (event) => {
      const card = event.target.closest(".image-card");
      const types = Array.from(event.dataTransfer?.types || []);
      if (!card) return;
      const targetRole = card.dataset.role || "";
      const files = droppedImageFiles(event.dataTransfer);
      if ((itemDragSource?.name || types.includes(ITEM_DRAG_TYPE)) && canAssignListItemToViewerControl(targetRole)) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = state.currentItem?.exists?.[targetRole] ? "move" : "copy";
        refs.viewerGrid.querySelectorAll(".role-drop-target").forEach((node) => {
          if (node !== card) node.classList.remove("role-drop-target");
        });
        card.classList.add("role-drop-target");
        return;
      }
      if (files.length === 1 && canAssignListItemToViewerControl(targetRole)) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        refs.viewerGrid.querySelectorAll(".role-drop-target").forEach((node) => {
          if (node !== card) node.classList.remove("role-drop-target");
        });
        card.classList.add("role-drop-target");
        return;
      }
      if (!types.includes(VIEWER_ROLE_DRAG_TYPE)) return;
      const sourceRole = state.viewerRoleDragging || "";
      if (!canSwapViewerRoles(sourceRole, targetRole)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      refs.viewerGrid.querySelectorAll(".role-drop-target").forEach((node) => {
        if (node !== card) node.classList.remove("role-drop-target");
      });
      card.classList.add("role-drop-target");
    });
    refs.viewerGrid.addEventListener("dragleave", (event) => {
      const card = event.target.closest(".image-card");
      if (!card || card.contains(event.relatedTarget)) return;
      card.classList.remove("role-drop-target");
    });
    refs.viewerGrid.addEventListener("drop", (event) => {
      const card = event.target.closest(".image-card");
      if (!card) return;
      const { sourceName, sourceRole: sourceItemRole } = itemDragPayload(event);
      const sourceRole = event.dataTransfer?.getData(VIEWER_ROLE_DRAG_TYPE) || "";
      const files = droppedImageFiles(event.dataTransfer);
      const targetRole = card.dataset.role || "";
      state.viewerRoleDragging = "";
      clearViewerRoleDragClasses();
      if (sourceName && canAssignListItemToViewerControl(targetRole)) {
        event.preventDefault();
        const targetExists = Boolean(state.currentItem?.exists?.[targetRole]);
        const normalizedSourceRole = sourceItemRole || "result";
        const action = targetExists
          ? swapItemImages(sourceName, normalizedSourceRole, state.currentItem.name, targetRole)
          : assignItemControlImage(sourceName, state.currentItem.name, targetRole, normalizedSourceRole);
        action.catch(showError || console.error);
        return;
      }
      if (files.length === 1 && canAssignListItemToViewerControl(targetRole)) {
        event.preventDefault();
        uploadControlImageFile(files[0], state.currentItem.name, targetRole).catch(showError || console.error);
        return;
      }
      if (!canSwapViewerRoles(sourceRole, targetRole)) return;
      event.preventDefault();
      swapViewerItemRoles(sourceRole, targetRole).catch(showError || console.error);
    });
  }

  function renderViewer() {
    const item = state.currentItem;
    ensureViewerRoleDragEvents();
    ensureViewerResizeObserver();
    refs.viewerGrid.dataset.mode = state.viewMode;
    refs.viewerGrid.dataset.imageMode = "fit";
    refs.currentName.textContent = item ? item.name : "未选择图片";
    renderCurrentMeta(item);

    const controlCount = activeControlCount();
    refs.viewModeGroup.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("active", controlCount > 0 && button.dataset.mode === state.viewMode);
    });

    const visibleRoles = visibleViewerRoles();

    refs.viewerGrid.querySelectorAll(".image-card").forEach((card) => {
      const role = card.dataset.role;
      card.style.display = visibleRoles.includes(role) ? "flex" : "none";
      card.draggable = Boolean(item?.exists?.[role]);
      card.classList.toggle("role-draggable", Boolean(item?.exists?.[role]));
      const stage = card.querySelector(".image-stage");
      const resLabel = card.querySelector(".res-label");
      if (!item || !item.exists[role]) {
        stage.textContent = "";
        const placeholder = document.createElement("div");
        placeholder.className = "placeholder";
        placeholder.textContent = `没有${ROLE_LABELS[role] || role}`;
        stage.appendChild(placeholder);
        resLabel.textContent = "";
        return;
      }
      stage.textContent = "";
      const img = document.createElement("img");
      img.src = imageUrl(role, item.name, false, 320, 220, imageVersionForItem(item, role));
      img.alt = item.name;
      img.draggable = false;
      img.title = "点击打开大图预览";
      img.addEventListener("load", () => updateViewerImageFit(img));
      img.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openImagePreview(role);
      });
      stage.appendChild(img);
      const size = item.resolution[role];
      resLabel.textContent = Array.isArray(size) ? `${size[0]}×${size[1]}` : "";
      const resultSize = item.resolution?.result;
      const hasResolutionMismatch =
        role !== "result" &&
        Array.isArray(size) &&
        Array.isArray(resultSize) &&
        (size[0] !== resultSize[0] || size[1] !== resultSize[1]);
      resLabel.classList.toggle("is-mismatch", hasResolutionMismatch);
    });

    const canProcess = Boolean(item);
    if (refs.viewerScaleBtn) refs.viewerScaleBtn.disabled = !canProcess;
    if (refs.viewerMatchResultBtn) refs.viewerMatchResultBtn.disabled = !canProcess || !item.exists.result;

    if (!item) {
      renderSelectionSummary();
      return;
    }

    renderSelectionSummary();
    updateAllViewerImageFits();
  }

  function shouldIgnoreListArrowNavigation(target) {
    if (document.body.classList.contains("image-preview-open")) return true;
    if (!(target instanceof Element)) return false;
    if (target.closest("input, textarea, select, button, a, .utility-page-shell, [contenteditable='true']")) return true;
    return false;
  }

  async function refreshItems(options = {}) {
    const { skipDirtyCheck = false, suppressSelectionSync = false, includeGlobalSegments = true } = options;
    const shouldRefreshGlobalSegments = includeGlobalSegments && !panelSegmentQuery("primary");
    const loadPanelItems = async (panelId) => apiGet("/api/items", {
      filter: panelFilter(panelId),
      tag: panelSegmentQuery(panelId),
      search_mode: panelSearchMode(panelId) === "name" ? "name" : "phrase",
      match_mode: panelSearchMatchMode(panelId) === "exact" ? "exact" : "contains",
      global_segments: panelId === "primary" && shouldRefreshGlobalSegments ? "1" : "0",
    });
    const data = await loadPanelItems("primary");
    if (data.workspace) state.workspace = data.workspace;
    setPanelItems("primary", data.items || []);
    state.itemStats = data.stats;
    if (shouldRefreshGlobalSegments) state.globalSegments = data.global_segments || data.global_tags || [];
    if (state.splitListOpen) {
      const secondaryData = await loadPanelItems("secondary");
      setPanelItems("secondary", secondaryData.items || []);
    }
    syncWorkspaceFolders();
    const rememberedSelection = storedListViewStateForActiveWorkspace();
    if (rememberedSelection) {
      state.itemFolderFilter = rememberedSelection.folderFilter;
      state.secondaryItemFolderFilter = rememberedSelection.secondaryFolderFilter;
    }
    renderFilters();
    renderItemList();
    if (shouldRefreshGlobalSegments) renderGlobalTags();
    renderWorkspaceSummary();

    const activePanel = rememberedSelection?.panel || activeListPanelId();
    if (rememberedSelection?.panel && rememberedSelection.panel !== state.selectedPanel) {
      state.selectedPanel = rememberedSelection.panel;
    }
    const activeVisibleItems = panelVisibleItems(activePanel);
    if (!activeVisibleItems.length) {
      state.selectedName = "";
      if (activePanel === "secondary") state.secondarySelectedName = "";
      else state.primarySelectedName = "";
      state.currentItem = null;
      saveListViewState();
      setCaptionEditorText("", { markSaved: true });
      renderViewer();
      renderTags();
      return;
    }

    if (suppressSelectionSync) {
      return;
    }

    const stillExists = activeVisibleItems.some((item) => item.name === state.selectedName);
    const rememberedExists = rememberedSelection?.name && activeVisibleItems.some((item) => item.name === rememberedSelection.name);
    const nextName = stillExists ? state.selectedName : rememberedExists ? rememberedSelection.name : activeVisibleItems[0].name;
    await selectItem(nextName, !stillExists || rememberedExists, { skipDirtyCheck, panelId: activePanel });
  }

  async function selectItem(name, rerenderList = true, options = {}) {
    const { skipDirtyCheck = false, panelId = activeListPanelId() } = options;
    if (!skipDirtyCheck && name !== state.selectedName) {
      const ok = await confirmDiscardCaptionChanges();
      if (!ok) return;
    }
    state.selectedPanel = panelId === "secondary" ? "secondary" : "primary";
    state.selectedName = name;
    if (state.selectedPanel === "secondary") state.secondarySelectedName = name;
    else state.primarySelectedName = name;
    if (!rerenderList) updateItemCardActiveState();
    const data = await apiGet("/api/item", { name });
    state.currentItem = data.item;
    saveListViewState();
    setCaptionEditorText(data.item.text || "", { markSaved: true });
    if (rerenderList) renderItemList();
    renderViewer();
    renderTags();
    scrollSelectedItemIntoView("nearest");
  }

  async function selectRelativeItem(offset) {
    const activeItems = panelVisibleItems(activeListPanelId());
    if (!activeItems.length) return;
    const currentIndex = activeItems.findIndex((item) => item.name === state.selectedName);
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = Math.max(0, Math.min(activeItems.length - 1, baseIndex + offset));
    const nextItem = activeItems[nextIndex];
    if (!nextItem || nextItem.name === state.selectedName) {
      scrollSelectedItemIntoView("nearest");
      return;
    }
    await selectItem(nextItem.name, true, { panelId: activeListPanelId() });
    scrollSelectedItemIntoView("nearest");
  }

  function prepareSelectionAfterRemoving(names = []) {
    const panelId = activeListPanelId();
    const nextName = nextNameAfterRemoving(panelId, names);
    return async () => {
      await refreshItems({ skipDirtyCheck: true, suppressSelectionSync: true });
      await selectAfterListMutation(panelId, nextName());
    };
  }

  function applyWorkspaceSummary(workspace) {
    const previousKey = state.workspace?.workspace_key || "";
    state.workspace = workspace;
    const nextKey = state.workspace?.workspace_key || "";
    state.workspaceImageVersion = (state.workspaceImageVersion || 0) + 1;
    state.imageRefreshToken = `${Date.now()}-${state.workspaceImageVersion}-${nextKey || previousKey}`;
    const dirs = state.workspace?.dirs || {};
    const settings = state.workspace?.settings || {};
    const hasLoadedWorkspace = Object.values(dirs).some(Boolean);
    if (hasLoadedWorkspace) {
      refs.controlCount.value = String(settings.control_count ?? refs.controlCount.value ?? "1");
    }
    refs.ignoreTokensInput.value = Array.isArray(settings.ignore_tokens)
      ? settings.ignore_tokens.join(", ")
      : refs.ignoreTokensInput.value;
    refs.control1Dir.value = workspacePathRelativeToBrowserRoot?.(dirs.control1) || dirs.control1 || "";
    refs.control2Dir.value = workspacePathRelativeToBrowserRoot?.(dirs.control2) || dirs.control2 || "";
    refs.control3Dir.value = workspacePathRelativeToBrowserRoot?.(dirs.control3) || dirs.control3 || "";
    refs.resultDir.value = workspacePathRelativeToBrowserRoot?.(dirs.result) || dirs.result || "";
    if (refs.swapControlDir && !refs.swapControlDir.value.trim() && dirs.control1) {
      refs.swapControlDir.value = dirs.control1;
    }
    if (refs.swapResultDir && !refs.swapResultDir.value.trim() && dirs.result) {
      refs.swapResultDir.value = dirs.result;
    }
    seedWorkspaceBrowserRootFromInputs();
    updateControlFieldVisibility();
    renderWorkspaceBrowser();
    renderWorkspaceSummary();
  }

  function clearWorkspaceView() {
    state.workspace = null;
    state.items = [];
    state.visibleItems = [];
    state.secondaryItems = [];
    state.secondaryVisibleItems = [];
    state.itemStats = null;
    state.selectedName = "";
    state.primarySelectedName = "";
    state.secondarySelectedName = "";
    state.currentItem = null;
    state.globalSegments = [];
    state.imageRefreshToken = `${Date.now()}-workspace-cleared`;
    clearListViewState();
    setCaptionEditorText("", { markSaved: true });
    renderFilters();
    renderItemList();
    renderViewer();
    renderTags();
    renderGlobalTags();
    renderWorkspaceSummary();
  }

  function ensureExportIncludeControlsForActiveControls() {
    const controlCount = activeControlCount();
    if (!refs.exportIncludeControls || controlCount < 1) return;
    refs.exportIncludeControls.checked = true;
    saveStored(STORAGE_KEYS.exportIncludeControls, "true");
  }

  function workspaceOpenPayloadFromInputs() {
    const controlCount = Number(refs.controlCount.value ?? 1);
    return {
      control1_dir: controlCount >= 1 ? (resolveWorkspaceInputPath?.(refs.control1Dir.value.trim()) || refs.control1Dir.value.trim()) : "",
      control2_dir: controlCount >= 2 ? (resolveWorkspaceInputPath?.(refs.control2Dir.value.trim()) || refs.control2Dir.value.trim()) : "",
      control3_dir: controlCount >= 3 ? (resolveWorkspaceInputPath?.(refs.control3Dir.value.trim()) || refs.control3Dir.value.trim()) : "",
      result_dir: resolveWorkspaceInputPath?.(refs.resultDir.value.trim()) || refs.resultDir.value.trim(),
      control_count: controlCount,
      ignore_tokens: refs.ignoreTokensInput.value.trim(),
    };
  }

  function saveLastWorkspaceOpenPayload(payload) {
    const hasDirectory = ["control1_dir", "control2_dir", "control3_dir", "result_dir"].some((key) => payload[key]);
    if (!hasDirectory) return;
    saveStored(STORAGE_KEYS.lastWorkspaceDirs, JSON.stringify(payload));
  }

  async function loadWorkspace() {
    const payload = workspaceOpenPayloadFromInputs();
    const data = await apiPost("/api/workspace/open", payload);
    applyWorkspaceSummary(data.workspace);
    saveLastWorkspaceOpenPayload(payload);
    await refreshItems();
    if (typeof autoSaveProjectAfterWorkspaceOpen === "function") {
      setAiStatusLine(state.currentProjectId ? "正在保存导入图片到当前项目..." : "正在创建缓存项目...");
      await autoSaveProjectAfterWorkspaceOpen();
    }
    closeUtilityPanel();
  }

  async function rescanWorkspace() {
    const data = await apiPost("/api/workspace/rescan", {});
    applyWorkspaceSummary(data.workspace);
    await refreshItems();
    setAiStatusLine("工作区已重扫。导入中的文件如果已落盘，现在会重新进入列表。");
  }

  async function mergeWorkspace() {
    const data = await apiPost("/api/workspace/merge", {
      control1_dir: refs.mergeControl1Dir.value.trim(),
      control2_dir: refs.mergeControl2Dir.value.trim(),
      control3_dir: refs.mergeControl3Dir.value.trim(),
      result_dir: refs.mergeResultDir.value.trim(),
      control_count: Number(refs.controlCount.value ?? 1),
    });
    applyWorkspaceSummary(data.workspace);
    await refreshItems({ skipDirtyCheck: true });
    if (typeof autoSaveProjectAfterWorkspaceOpen === "function") {
      setAiStatusLine(state.currentProjectId ? "正在保存追加图片到当前项目..." : "正在创建缓存项目...");
      await autoSaveProjectAfterWorkspaceOpen();
    }
    refs.mergeStatus.textContent = `已追加 ${data.merged || 0} 项到当前工作区`;
    setAiStatusLine(`已追加数据集：${data.merged || 0} 项`);
  }

  function updateControlFieldVisibility() {
    const formCount = formControlCount();
    const loadedCount = activeControlCount();
    const previousCount = Number(state.workspace?.settings?.control_count ?? refs.controlCount.dataset.previousCount ?? 1);
    document.querySelectorAll("[data-control-field]").forEach((node) => {
      const roleIndex = Number(node.getAttribute("data-control-field"));
      node.style.display = roleIndex <= formCount ? "" : "none";
    });
    document.querySelectorAll("[data-merge-control-field]").forEach((node) => {
      const roleIndex = Number(node.getAttribute("data-merge-control-field"));
      node.style.display = roleIndex <= formCount ? "" : "none";
    });

    [refs.filterGroup, refs.secondaryFilterGroup].filter(Boolean).forEach((group) => {
      group.querySelectorAll("button[data-filter]").forEach((button) => {
        const filter = button.dataset.filter;
        const shouldHide =
          (filter === "no_control1" && loadedCount < 1) ||
          (filter === "no_control2" && loadedCount < 2) ||
          (filter === "no_control3" && loadedCount < 3);
        button.style.display = shouldHide ? "none" : "";
      });
    });
    if (
      (state.filter === "no_control1" && loadedCount < 1) ||
      (state.filter === "no_control2" && loadedCount < 2) ||
      (state.filter === "no_control3" && loadedCount < 3)
    ) {
      state.filter = "all";
    }
    if (
      (state.secondaryFilter === "no_control1" && loadedCount < 1) ||
      (state.secondaryFilter === "no_control2" && loadedCount < 2) ||
      (state.secondaryFilter === "no_control3" && loadedCount < 3)
    ) {
      state.secondaryFilter = "all";
    }
    syncWorkspaceBrowserTargetVisibility();

    const allowedModes = loadedCount === 0 ? ["one"] : loadedCount === 1 ? ["one", "two"] : loadedCount === 2 ? ["one", "two", "three"] : ["one", "two", "three", "four"];
    refs.viewModeGroup.style.display = loadedCount > 0 ? "" : "none";
    refs.viewModeGroup.querySelectorAll("button[data-mode]").forEach((button) => {
      button.style.display = loadedCount > 0 && allowedModes.includes(button.dataset.mode) ? "" : "none";
    });
    if (loadedCount > previousCount) {
      state.viewMode = allowedModes.at(-1) || "two";
      saveStored(STORAGE_KEYS.viewMode, state.viewMode);
    } else if (!allowedModes.includes(state.viewMode)) {
      state.viewMode = allowedModes.at(-1) || "two";
      saveStored(STORAGE_KEYS.viewMode, state.viewMode);
    }
    refs.controlCount.dataset.previousCount = String(loadedCount);
    ensureExportIncludeControlsForActiveControls();
    renderFilters();
    if (state.items.length) {
      renderItemList();
    }
    if (state.currentItem) {
      renderViewer();
    }
  }

  return {
    renderWorkspaceSummary,
    renderFilters,
    renderItemList,
    renderViewer,
    shouldIgnoreListArrowNavigation,
    scrollSelectedItemIntoView,
    selectRelativeItem,
    prepareSelectionAfterRemoving,
    trashCurrentItem,
    trashSelectedOrCurrentItems,
    refreshItems,
    selectItem,
    applyWorkspaceSummary,
    clearWorkspaceView,
    loadWorkspace,
    rescanWorkspace,
    mergeWorkspace,
    updateControlFieldVisibility,
    toggleImagePreviewForCurrent,
  };
}

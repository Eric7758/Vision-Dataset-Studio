"""工作区批量操作组件。

从 DatasetWorkspace 提取的批量 segment/tag 操作、批量重命名、control/result
交换、上传/拖放、文件夹管理、文件移至回收站等批量写操作。
"""

from __future__ import annotations

import base64
import re
import shutil
import uuid
from collections import Counter
from pathlib import Path
from typing import Optional

from core.caption_text_utils import (
    _delete_caption_segments,
    _merge_text_with_segments,
    _normalize_segment_inputs,
    _replace_caption_segment,
)
from core.dataset_paths import resolve_user_path
from core.workspace_paths import (
    CONTROL_ROLES,
    IMAGE_EXTS,
    IMAGE_ROLES,
    WINDOWS_RESERVED_NAMES,
    _infer_image_suffix,
    _natural_key,
    _parse_rename_tokens,
)
from core.workspace_state import WorkspaceState, _StateProxy


class BatchOperations(_StateProxy):
    """批量操作组件。

    承载批量 segment/tag/重命名、control/result 交换、上传/拖放、文件夹管理、
    文件移至回收站等批量写操作。state 属性访问通过 _StateProxy 代理到 self._state；
    跨组件调用通过 self._workspace.xxx_method() 委托回门面。
    """

    def __init__(self, state: WorkspaceState, workspace):
        object.__setattr__(self, "_state", state)
        object.__setattr__(self, "_workspace", workspace)

    # ------------------------------------------------------------------
    # 批量 segment / tag
    # ------------------------------------------------------------------
    def batch_add_segments(self, names: list[str], segments: list[str], position: str = "after") -> dict:
        additions = _normalize_segment_inputs(segments)
        if not additions:
            return {"changed": 0}
        insert_position = "before" if position == "before" else "after"
        changed = 0
        for name in names:
            original = self.txt_content.get(name, "")
            updated = _merge_text_with_segments(original, additions, insert_position)
            if updated != original:
                self._workspace.save_text(name, updated)
                changed += 1
        return {"changed": changed}

    def batch_add_tags(self, names: list[str], tags: list[str], position: str = "after") -> dict:
        return self.batch_add_segments(names, tags, position)

    def batch_delete_segments(self, names: list[str], segments: list[str]) -> dict:
        needles = [segment.lower() for segment in _normalize_segment_inputs(segments)]
        if not needles:
            return {"changed": 0}
        changed = 0
        for name in names:
            original = self.txt_content.get(name, "")
            updated = _delete_caption_segments(original, needles)
            if updated != original:
                self._workspace.save_text(name, updated)
                changed += 1
        return {"changed": changed}

    def batch_delete_tags(self, names: list[str], tags: list[str]) -> dict:
        return self.batch_delete_segments(names, tags)

    def batch_replace_segment(self, names: list[str], old_segment: str, new_segment: str) -> dict:
        changed = 0
        old_segment = (old_segment or "").strip().lower()
        new_segment = (new_segment or "").strip()
        if not old_segment:
            return {"changed": 0}
        for name in names:
            original = self.txt_content.get(name, "")
            updated = _replace_caption_segment(original, old_segment, new_segment)
            if updated != original:
                self._workspace.save_text(name, updated)
                changed += 1
        return {"changed": changed}

    def batch_replace_tag(self, names: list[str], old_tag: str, new_tag: str) -> dict:
        return self.batch_replace_segment(names, old_tag, new_tag)

    # ------------------------------------------------------------------
    # 批量重命名
    # ------------------------------------------------------------------
    def _batch_rename_basename(
        self,
        basename: str,
        *,
        operation: str,
        value: str = "",
        old_value: str = "",
        new_value: str = "",
    ) -> str:
        operation = (operation or "").strip().lower()
        if operation == "add_prefix":
            addition = str(value or "")
            if not addition:
                raise ValueError("Rename text is required.")
            return self._workspace._clean_rename_basename(f"{addition}{basename}")
        if operation == "add_suffix":
            addition = str(value or "")
            if not addition:
                raise ValueError("Rename text is required.")
            return self._workspace._clean_rename_basename(f"{basename}{addition}")
        if operation == "delete":
            tokens = _parse_rename_tokens(value)
            if not tokens:
                raise ValueError("Delete text is required.")
            updated = basename
            for token in tokens:
                updated = updated.replace(token, "")
            return self._workspace._clean_rename_basename(updated)
        if operation == "replace":
            old_text = str(old_value or "")
            if not old_text:
                raise ValueError("Old rename text is required.")
            return self._workspace._clean_rename_basename(basename.replace(old_text, str(new_value or "")))
        raise ValueError(f"Unsupported batch rename operation: {operation}")

    def batch_rename_items(
        self,
        names: list[str],
        *,
        operation: str,
        value: str = "",
        old_value: str = "",
        new_value: str = "",
    ) -> dict:
        selected_names = [str(name or "") for name in names if str(name or "") in self.file_names]
        if not selected_names:
            return {"changed": 0, "renamed": [], "workspace": self._workspace.get_workspace_summary()}

        selected_set = set(selected_names)
        rename_map: dict[str, str] = {}
        for name in selected_names:
            old_name_path = Path(str(name).replace("\\", "/"))
            parent = old_name_path.parent.as_posix()
            basename = old_name_path.name
            clean_basename = self._batch_rename_basename(
                basename,
                operation=operation,
                value=value,
                old_value=old_value,
                new_value=new_value,
            )
            new_name = clean_basename if parent in {"", "."} else f"{parent}/{clean_basename}"
            rename_map[name] = new_name

        changed_map = {old: new for old, new in rename_map.items() if old != new}
        if not changed_map:
            return {"changed": 0, "renamed": [], "workspace": self._workspace.get_workspace_summary()}

        target_names = list(rename_map.values())
        duplicate_targets = [name for name, count in Counter(target_names).items() if count > 1]
        if duplicate_targets:
            raise FileExistsError(f"Batch rename would create duplicate item names: {', '.join(sorted(duplicate_targets, key=_natural_key))}")
        existing_conflicts = [name for name in target_names if name in self.file_names and name not in selected_set]
        if existing_conflicts:
            raise FileExistsError(f"Item already exists: {existing_conflicts[0]}")

        file_pairs: list[tuple[Path, Path]] = []
        for old_name, new_name in changed_map.items():
            clean_basename = Path(new_name.replace("\\", "/")).name
            for role in IMAGE_ROLES:
                source = self.files[role].get(old_name)
                if source:
                    target = source.with_name(f"{clean_basename}{source.suffix}")
                    if target != source:
                        file_pairs.append((source, target))
            txt_source = self.txt_files.get(old_name)
            if txt_source:
                target = txt_source.with_name(f"{clean_basename}{txt_source.suffix}")
                if target != txt_source:
                    file_pairs.append((txt_source, target))

        sources = {source.resolve() for source, _ in file_pairs}
        targets: set[Path] = set()
        for source, target in file_pairs:
            resolved_target = target.resolve()
            if resolved_target in targets:
                raise FileExistsError(f"Batch rename would create duplicate file: {target}")
            targets.add(resolved_target)
            if target.exists() and resolved_target not in sources:
                raise FileExistsError(f"Target file already exists: {target}")

        staged: list[tuple[Path, Path]] = []
        finalized: list[tuple[Path, Path]] = []
        try:
            for index, (source, _) in enumerate(file_pairs):
                if not source.exists():
                    raise FileNotFoundError(f"Source file does not exist: {source}")
                temp = source.with_name(f".vds_batch_rename_{uuid.uuid4().hex}_{index}{source.suffix}")
                while temp.exists():
                    temp = source.with_name(f".vds_batch_rename_{uuid.uuid4().hex}_{index}{source.suffix}")
                source.rename(temp)
                staged.append((source, temp))

            for (source, target), (_, temp) in zip(file_pairs, staged):
                temp.rename(target)
                finalized.append((source, target))
        except Exception:
            for source, target in reversed(finalized):
                try:
                    if target.exists() and not source.exists():
                        target.rename(source)
                except Exception:
                    pass
            for source, temp in reversed(staged):
                try:
                    if temp.exists() and not source.exists():
                        temp.rename(source)
                except Exception:
                    pass
            raise

        moved_paths = {source: target for source, target in file_pairs}
        self.file_names = [rename_map.get(name, name) for name in self.file_names]
        for role in IMAGE_ROLES:
            self.files[role] = {
                rename_map.get(name, name): moved_paths.get(path, path)
                for name, path in self.files[role].items()
            }
        self.txt_files = {
            rename_map.get(name, name): moved_paths.get(path, path)
            for name, path in self.txt_files.items()
        }
        self.txt_content = {
            rename_map.get(name, name): content
            for name, content in self.txt_content.items()
        }
        self.caption_overrides = {
            rename_map.get(name, name): content
            for name, content in self.caption_overrides.items()
        }
        self.caption_deleted = {rename_map.get(name, name) for name in self.caption_deleted}
        self.excluded_names = {rename_map.get(name, name) for name in self.excluded_names}
        self._image_sizes.clear()
        self._resolution_mismatch.clear()
        self._resolution_index_ready = False
        self._state.mark_global_segments_dirty()
        self.file_names = sorted(self.file_names, key=_natural_key)
        self._workspace._save_workspace_state()
        self._workspace._ensure_resolution_index()
        return {
            "changed": len(changed_map),
            "renamed": [{"old_name": old, "new_name": new} for old, new in changed_map.items()],
            "workspace": self._workspace.get_workspace_summary(),
        }

    # ------------------------------------------------------------------
    # Control / Result 交换
    # ------------------------------------------------------------------
    def _append_name_suffix(self, raw_name: str, suffix: str, index: int) -> str:
        raw_path = Path(str(raw_name or "untitled").replace("\\", "/"))
        extra = suffix if index <= 1 else f"{suffix}_{index}"
        next_name = f"{raw_path.name}{extra}"
        parent = raw_path.parent.as_posix()
        return next_name if parent in {"", "."} else f"{parent}/{next_name}"

    def _unique_swapped_raw_name(
        self,
        raw_name: str,
        suffix: str,
        used_raw_names: set[str],
        control_root: Path,
        result_root: Path,
        control_ext: str,
        result_ext: str,
    ) -> str:
        index = 1
        while True:
            candidate = self._append_name_suffix(raw_name, suffix, index)
            control_target = self._workspace._image_path_for_raw_name(control_root, candidate, control_ext)
            result_target = self._workspace._image_path_for_raw_name(result_root, candidate, result_ext)
            if candidate not in used_raw_names and not control_target.exists() and not result_target.exists():
                return candidate
            index += 1

    def swap_control_result_pairs(
        self,
        *,
        control_dir: Optional[str] = None,
        result_dir: Optional[str] = None,
        suffix: str = "_swap",
    ) -> dict:
        control_root = resolve_user_path(str(control_dir or self.dirs["control1"] or ""))
        result_root = resolve_user_path(str(result_dir or self.dirs["result"] or ""))
        if not control_root.is_dir():
            raise FileNotFoundError(f"control directory does not exist: {control_dir or ''}")
        if not result_root.is_dir():
            raise FileNotFoundError(f"result directory does not exist: {result_dir or ''}")
        if control_root.resolve() == result_root.resolve():
            raise ValueError("Control and result directories must be different.")

        clean_suffix = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", str(suffix or "").strip()) or "_swap"
        control_images = self._workspace._scan_images(control_root)
        result_images = self._workspace._scan_images(result_root)
        control_groups = self._workspace._group_images_by_match_key(control_images)
        result_groups = self._workspace._group_images_by_match_key(result_images)
        matched_keys = sorted(set(control_groups) & set(result_groups), key=_natural_key)
        if not matched_keys:
            summary = self._workspace.get_workspace_summary()
            return {"swapped": 0, "created": [], "skipped": [], "workspace": summary}

        used_raw_names = set(control_images) | set(result_images)
        created: list[dict] = []
        skipped: list[dict] = []
        for match_key in matched_keys:
            control_item = control_groups[match_key]
            result_item = result_groups[match_key]
            control_source = control_item["path"]
            result_source = result_item["path"]
            if control_source.resolve() == result_source.resolve():
                skipped.append({"name": result_item["raw_name"], "reason": "same source image"})
                continue

            base_raw_name = result_item["raw_name"] or control_item["raw_name"]
            new_raw_name = self._unique_swapped_raw_name(
                base_raw_name,
                clean_suffix,
                used_raw_names,
                control_root,
                result_root,
                result_source.suffix,
                control_source.suffix,
            )
            control_target = self._workspace._image_path_for_raw_name(control_root, new_raw_name, result_source.suffix)
            result_target = self._workspace._image_path_for_raw_name(result_root, new_raw_name, control_source.suffix)
            control_target.parent.mkdir(parents=True, exist_ok=True)
            result_target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(result_source, control_target)
            shutil.copy2(control_source, result_target)
            used_raw_names.add(new_raw_name)
            created.append({
                "name": new_raw_name,
                "control_source": str(control_source),
                "result_source": str(result_source),
                "control_target": str(control_target),
                "result_target": str(result_target),
            })

        summary = self._workspace.open_dirs(
            control1_dir=str(control_root),
            result_dir=str(result_root),
            control_count=max(1, self.control_count),
        )
        return {
            "swapped": len(created),
            "created": created,
            "skipped": skipped,
            "suffix": clean_suffix,
            "workspace": summary,
        }

    # ------------------------------------------------------------------
    # Control 图像分配 / 上传
    # ------------------------------------------------------------------
    def _first_item_image_path(self, name: str) -> Path:
        for role in ("result", "control1", "control2", "control3"):
            path = self.files.get(role, {}).get(name)
            if path and path.exists():
                return path
        raise FileNotFoundError(f"No image file found for item: {name}")

    def _item_image_path_for_role(self, name: str, role: str) -> Path:
        if role not in IMAGE_ROLES:
            raise ValueError("Source role must be an image role.")
        path = self.files.get(role, {}).get(name)
        if path and path.exists():
            return path
        raise FileNotFoundError(f"No {role} image found for item: {name}")

    def _item_image_path_for_preferred_role(self, name: str, role: str) -> tuple[Path, str]:
        if role:
            try:
                return self._item_image_path_for_role(name, role), role
            except FileNotFoundError:
                pass
        for fallback_role in ("result", "control1", "control2", "control3"):
            path = self.files.get(fallback_role, {}).get(name)
            if path and path.exists():
                return path, fallback_role
        raise FileNotFoundError(f"No image found for item: {name}")

    def _derive_control_dir(self, role: str) -> Path:
        for reference_role in CONTROL_ROLES:
            reference_dir = self.dirs.get(reference_role)
            if reference_dir:
                return reference_dir.parent / role
        result_dir = self.dirs.get("result")
        if result_dir:
            result_folder_names = {"result", "results", "output", "outputs", "target", "targets", "final", "edited"}
            return (result_dir.parent if result_dir.name.lower() in result_folder_names else result_dir) / role
        raise ValueError("At least one loaded image directory is required before creating a control folder.")

    def _control_dir_for_role(self, role: str) -> Path:
        current = self.dirs.get(role)
        target_dir = current if current else self._derive_control_dir(role)
        target_dir.mkdir(parents=True, exist_ok=True)
        self.dirs[role] = target_dir
        return target_dir

    def _derive_result_dir(self) -> Path:
        for reference_role in CONTROL_ROLES:
            reference_dir = self.dirs.get(reference_role)
            if reference_dir:
                return reference_dir.parent / "result"
        raise ValueError("At least one loaded image directory is required before creating a result folder.")

    def _result_dir_for_drop(self) -> Path:
        current = self.dirs.get("result")
        target_dir = current if current else self._derive_result_dir()
        target_dir.mkdir(parents=True, exist_ok=True)
        self.dirs["result"] = target_dir
        return target_dir

    def _clean_upload_image_stem(self, filename: str) -> str:
        stem = Path(str(filename or "")).stem.strip() or "dropped"
        stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", stem)
        stem = stem.strip(" .") or "dropped"
        if stem in {".", ".."}:
            stem = "dropped"
        if stem.upper() in WINDOWS_RESERVED_NAMES:
            stem = f"{stem}_image"
        return stem

    def _next_result_drop_path(self, filename: str, suffix: str) -> Path:
        result_dir = self._result_dir_for_drop()
        stem = self._clean_upload_image_stem(filename)
        index = 1
        while True:
            raw_name = stem if index <= 1 else f"{stem}_{index}"
            target_path = self._workspace._image_path_for_raw_name(result_dir, raw_name, suffix)
            if not any(self._workspace._image_path_for_raw_name(result_dir, raw_name, ext).exists() for ext in IMAGE_EXTS):
                return target_path
            index += 1

    def _image_dir_for_role_drop(self, role: str, folder: str = "") -> Path:
        if role == "result":
            target = self._result_dir_for_drop()
            if folder:
                target = target.joinpath(*self._workspace._clean_relative_folder(folder).split("/"))
                target.mkdir(parents=True, exist_ok=True)
            return target
        if role in CONTROL_ROLES:
            role_index = CONTROL_ROLES.index(role) + 1
            if self.control_count < role_index:
                raise ValueError(f"{role} is not enabled in the current workspace.")
            target = self._control_dir_for_role(role)
            if folder:
                target = target.joinpath(*self._workspace._clean_relative_folder(folder).split("/"))
                target.mkdir(parents=True, exist_ok=True)
            return target
        raise ValueError("Target role must be an image role.")

    def _next_role_drop_path(self, role: str, filename: str, suffix: str, folder: str = "") -> Path:
        target_dir = self._image_dir_for_role_drop(role, folder)
        stem = self._clean_upload_image_stem(filename)
        index = 1
        while True:
            raw_name = stem if index <= 1 else f"{stem}_{index}"
            target_path = self._workspace._image_path_for_raw_name(target_dir, raw_name, suffix)
            if not any(self._workspace._image_path_for_raw_name(target_dir, raw_name, ext).exists() for ext in IMAGE_EXTS):
                return target_path
            index += 1

    def _reference_raw_name_for_control_drop(self, target_name: str) -> str:
        for role in ("result", "control1", "control2", "control3"):
            root = self.dirs.get(role)
            path = self.files.get(role, {}).get(target_name)
            if root and path and path.exists():
                return self._workspace._relative_stem(root, path)
        return target_name

    def _next_control_drop_path(self, target_name: str, target_role: str, suffix: str) -> Path:
        target_dir = self._control_dir_for_role(target_role)
        reference_raw_name = self._reference_raw_name_for_control_drop(target_name)
        index = 1
        while True:
            target_raw_name = reference_raw_name if index <= 1 else self._append_name_suffix(reference_raw_name, "", index)
            target_path = self._workspace._image_path_for_raw_name(target_dir, target_raw_name, suffix)
            if not target_path.exists():
                return target_path
            index += 1

    def _validate_control_drop_target(self, target_name: str, target_role: str, allow_replace: bool = True):
        if target_role not in CONTROL_ROLES:
            raise ValueError("Target role must be a control image role.")
        role_index = CONTROL_ROLES.index(target_role) + 1
        if self.control_count < role_index:
            raise ValueError(f"{target_role} is not enabled in the current workspace.")
        if target_name not in self.file_names:
            raise KeyError(target_name)
        if not allow_replace and target_name in self.files[target_role]:
            raise ValueError(f"{target_role} already exists for {target_name}.")

    def _control_drop_target_path(self, target_name: str, target_role: str, suffix: str) -> tuple[Path, Path | None]:
        existing_path = self.files[target_role].get(target_name)
        if existing_path and existing_path.exists():
            suffix = suffix.lower()
            target_path = existing_path.with_suffix(suffix)
            if target_path != existing_path and target_path.exists():
                raise FileExistsError(f"Target file already exists: {target_path}")
            return target_path, existing_path
        return self._next_control_drop_path(target_name, target_role, suffix), None

    def _apply_control_drop_result(self, target_name: str, target_role: str, target_path: Path):
        self.files[target_role][target_name] = target_path
        self.workspace_key = self._workspace._compute_workspace_key()
        self._workspace._refresh_item_resolution_flag(target_name)
        self._state.mark_global_segments_dirty()
        return self._workspace.get_workspace_summary()

    def assign_control_image(self, source_name: str, target_name: str, target_role: str, source_role: str = "") -> dict:
        source_name = str(source_name or "").strip()
        target_name = str(target_name or "").strip()
        target_role = str(target_role or "").strip()
        source_role = str(source_role or "").strip()
        if source_name not in self.file_names:
            raise KeyError(source_name)
        self._validate_control_drop_target(target_name, target_role, allow_replace=True)

        source_path, actual_source_role = self._item_image_path_for_preferred_role(source_name, source_role)
        target_path, replaced_path = self._control_drop_target_path(target_name, target_role, source_path.suffix)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        if source_path.resolve() != target_path.resolve():
            shutil.copy2(source_path, target_path)
            if replaced_path and replaced_path != target_path and replaced_path.exists():
                replaced_path.unlink()

        summary = self._apply_control_drop_result(target_name, target_role, target_path)
        return {
            "source_name": source_name,
            "source_role": actual_source_role,
            "requested_source_role": source_role,
            "target_name": target_name,
            "target_role": target_role,
            "copied": {"from": str(source_path), "to": str(target_path)},
            "replaced": str(replaced_path) if replaced_path else "",
            "workspace": summary,
        }

    def upload_control_image(self, target_name: str, target_role: str, filename: str, image_data: str, mime_type: str = "") -> dict:
        target_name = str(target_name or "").strip()
        target_role = str(target_role or "").strip()
        filename = str(filename or "").strip() or "dropped.png"
        suffix = _infer_image_suffix(filename, mime_type)
        if suffix not in IMAGE_EXTS:
            raise ValueError("Dropped file must be an image.")
        self._validate_control_drop_target(target_name, target_role, allow_replace=True)
        raw_data = str(image_data or "")
        if "," in raw_data and raw_data.split(",", 1)[0].lower().startswith("data:"):
            raw_data = raw_data.split(",", 1)[1]
        try:
            payload = base64.b64decode(raw_data, validate=True)
        except Exception as exc:
            raise ValueError(f"Invalid dropped image data: {exc}") from exc
        if not payload:
            raise ValueError("Dropped image is empty.")

        target_path, replaced_path = self._control_drop_target_path(target_name, target_role, suffix)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_bytes(payload)
        if replaced_path and replaced_path != target_path and replaced_path.exists():
            replaced_path.unlink()

        summary = self._apply_control_drop_result(target_name, target_role, target_path)
        return {
            "target_name": target_name,
            "target_role": target_role,
            "saved": {"filename": filename, "path": str(target_path)},
            "replaced": str(replaced_path) if replaced_path else "",
            "workspace": summary,
        }

    def upload_result_image(self, filename: str, image_data: str) -> dict:
        return self.upload_role_image("result", filename, image_data)

    def upload_role_image(self, role: str, filename: str, image_data: str, mime_type: str = "", folder: str = "") -> dict:
        role = str(role or "").strip()
        if role not in IMAGE_ROLES:
            raise ValueError("Target role must be an image role.")
        filename = str(filename or "").strip() or "dropped.png"
        suffix = _infer_image_suffix(filename, mime_type)
        if suffix not in IMAGE_EXTS:
            raise ValueError("Dropped file must be an image.")
        clean_folder = self._workspace._clean_relative_folder(folder) if str(folder or "").strip() else ""
        raw_data = str(image_data or "")
        if "," in raw_data and raw_data.split(",", 1)[0].lower().startswith("data:"):
            raw_data = raw_data.split(",", 1)[1]
        try:
            payload = base64.b64decode(raw_data, validate=True)
        except Exception as exc:
            raise ValueError(f"Invalid dropped image data: {exc}") from exc
        if not payload:
            raise ValueError("Dropped image is empty.")

        target_path = self._next_role_drop_path(role, filename, suffix, clean_folder)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_bytes(payload)
        root = self.dirs.get(role)
        saved_name = self._workspace._relative_stem(root, target_path) if root else target_path.stem
        self.files[role][saved_name] = target_path
        if saved_name not in self.file_names and saved_name not in self.excluded_names:
            self.file_names.append(saved_name)
            self.file_names = sorted(self.file_names, key=_natural_key)
        self.workspace_key = self._workspace._compute_workspace_key()
        self._workspace._refresh_item_resolution_flag(saved_name)
        self._state.mark_global_segments_dirty()
        summary = self._workspace.get_workspace_summary()
        return {
            "name": saved_name,
            "role": role,
            "saved": {"filename": filename, "path": str(target_path)},
            "workspace": summary,
        }

    # ------------------------------------------------------------------
    # 文件夹管理 / 移动
    # ------------------------------------------------------------------
    def move_item_to_folder(self, name: str, target_folder: str) -> dict:
        if name not in self.file_names:
            raise KeyError(name)

        clean_folder = self._workspace._clean_relative_folder(target_folder) if str(target_folder or "").strip() else ""
        old_name_path = Path(str(name).replace("\\", "/"))
        basename = old_name_path.name
        current_folder = old_name_path.parent.as_posix()
        current_folder = "" if current_folder == "." else current_folder
        new_name = f"{clean_folder}/{basename}" if clean_folder else basename
        if clean_folder == current_folder:
            return {
                "old_name": name,
                "new_name": name,
                "moved": [],
                "item": self._workspace._serialize_item(name),
                "workspace": self._workspace.get_workspace_summary(),
            }
        if new_name in self.file_names:
            raise FileExistsError(f"Item already exists: {new_name}")

        move_pairs: list[tuple[Path, Path]] = []
        folder_parts = clean_folder.split("/") if clean_folder else []
        for role in IMAGE_ROLES:
            source = self.files[role].get(name)
            root = self.dirs.get(role)
            if not source or not root:
                continue
            target = root.joinpath(*folder_parts, source.name)
            if target == source:
                continue
            if target.exists():
                raise FileExistsError(f"Target file already exists: {target}")
            move_pairs.append((source, target))

        txt_source = self.txt_files.get(name)
        txt_root = self.dirs.get("result")
        if txt_source and txt_root:
            txt_target = txt_root.joinpath(*folder_parts, txt_source.name)
            if txt_target != txt_source:
                if txt_target.exists():
                    raise FileExistsError(f"Target file already exists: {txt_target}")
                move_pairs.append((txt_source, txt_target))

        moved: list[tuple[Path, Path]] = []
        try:
            for source, target in move_pairs:
                if not source.exists():
                    raise FileNotFoundError(f"Source file does not exist: {source}")
                target.parent.mkdir(parents=True, exist_ok=True)
                source.rename(target)
                moved.append((source, target))
        except Exception:
            for source, target in reversed(moved):
                try:
                    if target.exists() and not source.exists():
                        source.parent.mkdir(parents=True, exist_ok=True)
                        target.rename(source)
                except Exception:
                    pass
            raise

        moved_paths = {source: target for source, target in move_pairs}
        self.file_names = [new_name if item == name else item for item in self.file_names]
        for role in IMAGE_ROLES:
            if name in self.files[role]:
                source = self.files[role].pop(name)
                self.files[role][new_name] = moved_paths.get(source, source)
        if name in self.txt_files:
            source = self.txt_files.pop(name)
            self.txt_files[new_name] = moved_paths.get(source, source)
        if name in self.txt_content:
            self.txt_content[new_name] = self.txt_content.pop(name)
        if name in self.caption_overrides:
            self.caption_overrides[new_name] = self.caption_overrides.pop(name)
        if name in self.caption_deleted:
            self.caption_deleted.discard(name)
            self.caption_deleted.add(new_name)
        if name in self.excluded_names:
            self.excluded_names.discard(name)
            self.excluded_names.add(new_name)

        self._image_sizes.clear()
        self._resolution_mismatch.clear()
        self._resolution_index_ready = False
        self._state.mark_global_segments_dirty()
        self.file_names = sorted(self.file_names, key=_natural_key)
        self._workspace._save_workspace_state()
        self._workspace._ensure_resolution_index()
        return {
            "old_name": name,
            "new_name": new_name,
            "moved": [{"from": str(source), "to": str(target)} for source, target in move_pairs],
            "item": self._workspace._serialize_item(new_name),
            "workspace": self._workspace.get_workspace_summary(),
        }

    def move_items_to_folder(self, names: list[str], target_folder: str) -> dict:
        selected = [str(name or "").strip() for name in names if str(name or "").strip()]
        if not selected:
            raise ValueError("No items selected.")
        clean_folder = self._workspace._clean_relative_folder(target_folder) if str(target_folder or "").strip() else ""
        moved_items: list[dict] = []
        skipped_items: list[dict] = []
        seen: set[str] = set()
        for name in selected:
            if name in seen:
                continue
            seen.add(name)
            try:
                result = self.move_item_to_folder(name, clean_folder)
            except KeyError:
                skipped_items.append({
                    "name": name,
                    "reason": "not_found",
                    "message": f"Item not found: {name}",
                })
            except FileExistsError:
                basename = Path(name).name
                target_name = f"{clean_folder}/{basename}" if clean_folder else basename
                skipped_items.append({
                    "name": name,
                    "reason": "already_exists",
                    "message": f"Target item already exists: {target_name}",
                })
            except FileNotFoundError:
                skipped_items.append({
                    "name": name,
                    "reason": "not_found",
                    "message": f"Source files not found: {name}",
                })
            else:
                moved_items.append({
                    "old_name": result["old_name"],
                    "new_name": result["new_name"],
                    "moved": result["moved"],
                })
        return {
            "moved": moved_items,
            "skipped": skipped_items,
            "workspace": self._workspace.get_workspace_summary(),
        }

    def create_folder(self, folder: str) -> dict:
        clean_folder = self._workspace._clean_relative_folder(folder)
        self._workspace_folders.add(clean_folder)
        self._workspace._save_workspace_state()
        created: list[str] = []
        for role in IMAGE_ROLES:
            root = self.dirs.get(role)
            if not root:
                continue
            target = root.joinpath(*clean_folder.split("/"))
            target.mkdir(parents=True, exist_ok=True)
            created.append(str(target))
        return {
            "folder": clean_folder,
            "created": created,
            "workspace": self._workspace.get_workspace_summary(),
        }

    def rename_folder(self, folder: str, new_folder: str) -> dict:
        source = self._workspace._clean_relative_folder(folder)
        target = self._workspace._clean_relative_folder(new_folder)
        if source == target:
            return {
                "old_folder": source,
                "new_folder": target,
                "renamed": [],
                "workspace": self._workspace.get_workspace_summary(),
            }

        source_prefix = f"{source}/"
        if target == source or target.startswith(source_prefix):
            raise ValueError("Target folder cannot be inside the source folder.")

        matched_names = [name for name in self.file_names if name == source or name.startswith(source_prefix)]
        if not matched_names and not self._workspace._folder_exists_on_disk(source):
            raise FileNotFoundError(f"Folder does not exist: {source}")

        rename_pairs: list[tuple[Path, Path]] = []
        roots = self._workspace._workspace_roots()
        for root in roots:
            source_path = root / Path(source)
            if not source_path.exists():
                continue
            target_path = root / Path(target)
            if target_path.exists():
                raise FileExistsError(f"Target folder already exists: {target}")
            rename_pairs.append((source_path, target_path))

        moved_roots: list[tuple[Path, Path]] = []
        try:
            for source_path, target_path in rename_pairs:
                target_path.parent.mkdir(parents=True, exist_ok=True)
                source_path.rename(target_path)
                moved_roots.append((source_path, target_path))
        except Exception:
            for source_path, target_path in reversed(moved_roots):
                try:
                    if target_path.exists() and not source_path.exists():
                        target_path.rename(source_path)
                except Exception:
                    pass
            raise

        updated_names: dict[str, str] = {}
        for name in self.file_names:
            if name == source:
                updated_names[name] = target
            elif name.startswith(source_prefix):
                suffix = name[len(source_prefix):]
                updated_names[name] = f"{target}/{suffix}"

        if updated_names:
            self.file_names = [updated_names.get(name, name) for name in self.file_names]
            for role in IMAGE_ROLES:
                self.files[role] = {
                    updated_names.get(name, name): path
                    for name, path in self.files[role].items()
                }
            self.txt_files = {
                updated_names.get(name, name): path
                for name, path in self.txt_files.items()
            }
            self.txt_content = {
                updated_names.get(name, name): content
                for name, content in self.txt_content.items()
            }
            self.caption_overrides = {
                updated_names.get(name, name): content
                for name, content in self.caption_overrides.items()
            }
            self.caption_deleted = {updated_names.get(name, name) for name in self.caption_deleted}
            self.excluded_names = {updated_names.get(name, name) for name in self.excluded_names}

        self._workspace._rewrite_workspace_folder_prefix(source, target)
        self._workspace._refresh_workspace_folders()
        self._image_sizes.clear()
        self._resolution_mismatch.clear()
        self._resolution_index_ready = False
        self._state.mark_global_segments_dirty()
        self.file_names = sorted(self.file_names, key=_natural_key)
        self._workspace._save_workspace_state()
        self._workspace._ensure_resolution_index()
        return {
            "old_folder": source,
            "new_folder": target,
            "renamed": [{"from": str(source_path), "to": str(target_path)} for source_path, target_path in moved_roots],
            "workspace": self._workspace.get_workspace_summary(),
        }

    def delete_folder(self, folder: str) -> dict:
        clean_folder = self._workspace._clean_relative_folder(folder)
        folder_prefix = f"{clean_folder}/"
        if any(name == clean_folder or name.startswith(folder_prefix) for name in self.file_names):
            raise ValueError("Folder is not empty. Move or delete its items first.")
        roots = self._workspace._workspace_roots()
        removed: list[str] = []
        for root in roots:
            target = root / Path(clean_folder)
            if not target.exists():
                continue
            self._workspace._prune_empty_dir(target, root)
            removed.append(str(target))
        self._workspace_folders = {
            folder_name
            for folder_name in self._workspace_folders
            if not (folder_name == clean_folder or folder_name.startswith(folder_prefix))
        }
        self._workspace._refresh_workspace_folders()
        self._workspace._save_workspace_state()
        return {
            "folder": clean_folder,
            "removed": removed,
            "workspace": self._workspace.get_workspace_summary(),
        }

    # ------------------------------------------------------------------
    # 文件移至回收站
    # ------------------------------------------------------------------
    def trash_item_files(self, name: str) -> dict:
        if name not in self.file_names:
            raise KeyError(name)

        path_entries: list[tuple[str, Path]] = []
        seen_paths: set[Path] = set()
        for role in IMAGE_ROLES:
            path = self.files[role].get(name)
            if path and path.exists() and path not in seen_paths:
                path_entries.append((role, path))
                seen_paths.add(path)
        txt_path = self.txt_files.get(name)
        if txt_path and txt_path.exists() and txt_path not in seen_paths:
            path_entries.append(("txt", txt_path))
            seen_paths.add(txt_path)

        if not path_entries:
            self.file_names = [item for item in self.file_names if item != name]
            self.caption_overrides.pop(name, None)
            self.caption_deleted.discard(name)
            self.excluded_names.discard(name)
            self._workspace._save_workspace_state()
            return {"trashed": [], "workspace": self._workspace.get_workspace_summary()}

        # 延迟 import 以支持测试 monkey-patch core.dataset_workspace._send_to_trash
        from core import dataset_workspace as _dws

        trashed: list[tuple[str, Path]] = []
        for role, path in path_entries:
            _dws._send_to_trash(path)
            trashed.append((role, path))

        for role, path in trashed:
            if role in IMAGE_ROLES and self.files[role].get(name) == path:
                self.files[role].pop(name, None)
            elif role == "txt" and self.txt_files.get(name) == path:
                self.txt_files.pop(name, None)
                self.txt_content.pop(name, None)

        self.caption_overrides.pop(name, None)
        self.caption_deleted.discard(name)
        self.excluded_names.discard(name)
        has_remaining = any(name in self.files[role] for role in IMAGE_ROLES) or name in self.txt_files
        if not has_remaining:
            self.file_names = [item for item in self.file_names if item != name]
        for key in list(self._image_sizes.keys()):
            if key[1] == name:
                self._image_sizes.pop(key, None)
        self._resolution_mismatch.discard(name)
        self._resolution_index_ready = False
        self._state.mark_global_segments_dirty()
        self._workspace._save_workspace_state()
        self._workspace._ensure_resolution_index()
        return {
            "trashed": [{"role": role, "path": str(path)} for role, path in trashed],
            "removed_name": name if not has_remaining else "",
            "workspace": self._workspace.get_workspace_summary(),
        }

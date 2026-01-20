import { type SelectItem, SelectList, type SettingItem, SettingsList } from "@mariozechner/pi-tui";
import {
  filterableSelectListTheme,
  searchableSelectListTheme,
  selectListTheme,
  settingsListTheme,
} from "../theme/theme.js";
import { FilterableSelectList, type FilterableSelectItem } from "./filterable-select-list.js";
import { SearchableSelectList } from "./searchable-select-list.js";

export function createSelectList(items: SelectItem[], maxVisible = 7) {
  return new SelectList(items, maxVisible, selectListTheme);
}

export function createSearchableSelectList(items: SelectItem[], maxVisible = 7) {
  return new SearchableSelectList(items, maxVisible, searchableSelectListTheme);
}

export function createFilterableSelectList(items: FilterableSelectItem[], maxVisible = 7) {
  return new FilterableSelectList(items, maxVisible, filterableSelectListTheme);
}

export function createSettingsList(
  items: SettingItem[],
  onChange: (id: string, value: string) => void,
  onCancel: () => void,
  maxVisible = 7,
) {
  return new SettingsList(items, maxVisible, settingsListTheme, onChange, onCancel);
}

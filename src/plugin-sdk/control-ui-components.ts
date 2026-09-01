import type { BoardGetParams } from "@openclaw/gateway-protocol";

/** Semantic host components available to native Control UI plugins. */
export type ControlUiComponentHandle<T> = {
  update: (props: T) => void;
  dispose: () => void;
};

export type ControlUiDialogProps = {
  label: string;
  description?: string;
  className?: string;
  style?: string;
  /** The plugin retains rendering ownership of this node. */
  content: HTMLElement;
  returnFocusTarget?: HTMLElement | null;
  /** Returning false keeps the dialog open, for example during a pending save. */
  onCancel: () => boolean | void;
};

export type ControlUiAgentPickerProps = {
  options: readonly {
    value: string;
    label: string;
    description?: string;
    badge?: string;
    disabled?: boolean;
    agent?: { id: string };
    icon?: "bot" | "users";
  }[];
  value: string;
  placeholder?: string;
  accessibleLabel: string;
  menuLabel?: string;
  disabled?: boolean;
  onSelect: (value: string) => void;
};

export type ControlUiDashboardProps = {
  session: BoardGetParams;
  canMutate: boolean;
  canGrant: boolean;
  presented?: boolean;
};

export type ControlUiComponents = {
  mountDialog: (
    container: HTMLElement,
    props: ControlUiDialogProps,
  ) => ControlUiComponentHandle<ControlUiDialogProps>;
  mountAgentPicker: (
    container: HTMLElement,
    props: ControlUiAgentPickerProps,
  ) => ControlUiComponentHandle<ControlUiAgentPickerProps>;
  mountDashboard: (
    container: HTMLElement,
    props: ControlUiDashboardProps,
  ) => ControlUiComponentHandle<ControlUiDashboardProps>;
};

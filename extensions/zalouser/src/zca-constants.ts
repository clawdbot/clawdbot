export const ThreadType = {
  User: 0,
  Group: 1,
} as const;

export const LoginQRCallbackEventType = {
  QRCodeGenerated: 0,
  QRCodeExpired: 1,
  QRCodeScanned: 2,
  QRCodeDeclined: 3,
  GotLoginInfo: 4,
} as const;

export const Reactions = {
  HEART: "/-heart",
  LIKE: "/-strong",
  HAHA: ":>",
  WOW: ":o",
  CRY: ":-((",
  ANGRY: ":-h",
  NONE: "",
} as const;

// Mirror zca-js sendMessage style constants locally because the package root
// typing surface does not consistently expose TextStyle/Style to tsgo.
export const TextStyle = {
  Bold: "b",
  Italic: "i",
  Underline: "u",
  StrikeThrough: "s",
  Red: "c_db342e",
  Orange: "c_f27806",
  Yellow: "c_f7b503",
  Green: "c_15a85f",
  Small: "f_13",
  Big: "f_18",
  UnorderedList: "lst_1",
  OrderedList: "lst_2",
  Indent: "ind_$",
} as const;

type TextStyleValue = (typeof TextStyle)[keyof typeof TextStyle];

export type Style =
  | {
      start: number;
      len: number;
      st: Exclude<TextStyleValue, typeof TextStyle.Indent>;
    }
  | {
      start: number;
      len: number;
      st: typeof TextStyle.Indent;
      indentSize?: number;
    };

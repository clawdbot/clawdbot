export type FeishuBlockText = {
  elements?: Array<{
    text_run?: {
      content?: string;
    };
  }>;
};

export type FeishuBlockTableProperty = {
  row_size?: number;
  column_size?: number;
  column_width?: number[];
};

export type FeishuBlockTable = {
  property?: FeishuBlockTableProperty;
  merge_info?: Array<{ row_span?: number; col_span?: number }>;
  cells?: string[];
};

export type FeishuDocxBlock = {
  block_id?: string;
  parent_id?: string;
  children?: string[] | string;
  block_type: number;
  text?: FeishuBlockText;
  table?: FeishuBlockTable;
  image?: object;
  [key: string]: object | string | number | boolean | string[] | undefined;
};

export type FeishuDocxBlockChild = {
  block_id?: string;
  parent_id?: string;
  block_type?: number;
  children?: string[] | FeishuDocxBlockChild[];
  table?: FeishuBlockTable;
};

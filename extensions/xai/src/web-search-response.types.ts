export type XaiWebSearchResponse = {
  output?: Array<{
    type?: string;
    text?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
      } | null>;
    } | null>;
    annotations?: Array<{
      type?: string;
      url?: string;
    } | null>;
  } | null>;
  output_text?: string;
  citations?: string[];
  inline_citations?: Array<{
    start_index: number;
    end_index: number;
    url: string;
  }>;
};

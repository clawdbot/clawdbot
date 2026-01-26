import { describe, expect, it } from "vitest";
import {
  createConfirmTemplate,
  createButtonTemplate,
  createTemplateCarousel,
  createCarouselColumn,
  createImageCarousel,
  createImageCarouselColumn,
  createYesNoConfirm,
  createButtonMenu,
  createLinkMenu,
  createProductCarousel,
  messageAction,
  uriAction,
  postbackAction,
  datetimePickerAction,
} from "./template-messages.js";

describe("messageAction", () => {
  it("creates a message action", () => {
    const action = messageAction("Click me", "clicked");

    expect(action.type).toBe("message");
    expect(action.label).toBe("Click me");
    expect((action as { text: string }).text).toBe("clicked");
  });

  it("uses label as text when text not provided", () => {
    const action = messageAction("Click");

    expect((action as { text: string }).text).toBe("Click");
  });

  it("truncates label to 20 characters", () => {
    const action = messageAction("This is a very long label that exceeds the limit");

    expect(action.label).toBe("This is a very long ");
  });
});

describe("uriAction", () => {
  it("creates a URI action", () => {
    const action = uriAction("Visit", "https://example.com");

    expect(action.type).toBe("uri");
    expect(action.label).toBe("Visit");
    expect((action as { uri: string }).uri).toBe("https://example.com");
  });
});

describe("postbackAction", () => {
  it("creates a postback action", () => {
    const action = postbackAction("Select", "action=select&id=1");

    expect(action.type).toBe("postback");
    expect(action.label).toBe("Select");
    expect((action as { data: string }).data).toBe("action=select&id=1");
  });

  it("includes displayText when provided", () => {
    const action = postbackAction("Select", "data", "Selected!");

    expect((action as { displayText: string }).displayText).toBe("Selected!");
  });

  it("truncates data to 300 characters", () => {
    const longData = "x".repeat(400);
    const action = postbackAction("Test", longData);

    expect((action as { data: string }).data.length).toBe(300);
  });
});

describe("datetimePickerAction", () => {
  it("creates a datetime picker action", () => {
    const action = datetimePickerAction("Pick date", "date_selected", "date");

    expect(action.type).toBe("datetimepicker");
    expect(action.label).toBe("Pick date");
    expect((action as { mode: string }).mode).toBe("date");
  });

  it("includes min/max/initial when provided", () => {
    const action = datetimePickerAction("Pick", "data", "datetime", {
      initial: "2024-01-01T12:00",
      min: "2024-01-01T00:00",
      max: "2024-12-31T23:59",
    });

    expect((action as { initial: string }).initial).toBe("2024-01-01T12:00");
    expect((action as { min: string }).min).toBe("2024-01-01T00:00");
    expect((action as { max: string }).max).toBe("2024-12-31T23:59");
  });
});

describe("createConfirmTemplate", () => {
  it("creates a confirm template", () => {
    const confirm = messageAction("Yes");
    const cancel = messageAction("No");
    const template = createConfirmTemplate("Are you sure?", confirm, cancel);

    expect(template.type).toBe("template");
    expect(template.template.type).toBe("confirm");
    expect((template.template as { text: string }).text).toBe("Are you sure?");
  });

  it("truncates text to 240 characters", () => {
    const longText = "x".repeat(300);
    const template = createConfirmTemplate(longText, messageAction("Yes"), messageAction("No"));

    expect((template.template as { text: string }).text.length).toBe(240);
  });

  it("uses custom altText when provided", () => {
    const template = createConfirmTemplate(
      "Question?",
      messageAction("Yes"),
      messageAction("No"),
      "Custom alt",
    );

    expect(template.altText).toBe("Custom alt");
  });
});

describe("createButtonTemplate", () => {
  it("creates a button template", () => {
    const actions = [messageAction("Button 1"), messageAction("Button 2")];
    const template = createButtonTemplate("Title", "Description", actions);

    expect(template.type).toBe("template");
    expect(template.template.type).toBe("buttons");
    expect((template.template as { title: string }).title).toBe("Title");
    expect((template.template as { text: string }).text).toBe("Description");
  });

  it("limits actions to 4", () => {
    const actions = Array.from({ length: 6 }, (_, i) => messageAction(`Button ${i}`));
    const template = createButtonTemplate("Title", "Text", actions);

    expect((template.template as { actions: unknown[] }).actions.length).toBe(4);
  });

  it("truncates title to 40 characters", () => {
    const longTitle = "x".repeat(50);
    const template = createButtonTemplate(longTitle, "Text", [messageAction("OK")]);

    expect((template.template as { title: string }).title.length).toBe(40);
  });

  it("includes thumbnail when provided", () => {
    const template = createButtonTemplate("Title", "Text", [messageAction("OK")], {
      thumbnailImageUrl: "https://example.com/thumb.jpg",
    });

    expect((template.template as { thumbnailImageUrl: string }).thumbnailImageUrl).toBe(
      "https://example.com/thumb.jpg",
    );
  });

  it("truncates text to 60 chars when no thumbnail is provided", () => {
    const longText = "x".repeat(100);
    const template = createButtonTemplate("Title", longText, [messageAction("OK")]);

    expect((template.template as { text: string }).text.length).toBe(60);
  });

  it("keeps longer text when thumbnail is provided", () => {
    const longText = "x".repeat(100);
    const template = createButtonTemplate("Title", longText, [messageAction("OK")], {
      thumbnailImageUrl: "https://example.com/thumb.jpg",
    });

    expect((template.template as { text: string }).text.length).toBe(100);
  });
});

describe("createTemplateCarousel", () => {
  it("creates a carousel template", () => {
    const columns = [
      createCarouselColumn({ text: "Column 1", actions: [messageAction("Select")] }),
      createCarouselColumn({ text: "Column 2", actions: [messageAction("Select")] }),
    ];
    const template = createTemplateCarousel(columns);

    expect(template.type).toBe("template");
    expect(template.template.type).toBe("carousel");
    expect((template.template as { columns: unknown[] }).columns.length).toBe(2);
  });

  it("limits columns to 10", () => {
    const columns = Array.from({ length: 15 }, () =>
      createCarouselColumn({ text: "Text", actions: [messageAction("OK")] }),
    );
    const template = createTemplateCarousel(columns);

    expect((template.template as { columns: unknown[] }).columns.length).toBe(10);
  });
});

describe("createCarouselColumn", () => {
  it("creates a carousel column", () => {
    const column = createCarouselColumn({
      title: "Item",
      text: "Description",
      actions: [messageAction("View")],
      thumbnailImageUrl: "https://example.com/img.jpg",
    });

    expect(column.title).toBe("Item");
    expect(column.text).toBe("Description");
    expect(column.thumbnailImageUrl).toBe("https://example.com/img.jpg");
    expect(column.actions.length).toBe(1);
  });

  it("limits actions to 3", () => {
    const column = createCarouselColumn({
      text: "Text",
      actions: [
        messageAction("A1"),
        messageAction("A2"),
        messageAction("A3"),
        messageAction("A4"),
        messageAction("A5"),
      ],
    });

    expect(column.actions.length).toBe(3);
  });

  it("truncates text to 120 characters", () => {
    const longText = "x".repeat(150);
    const column = createCarouselColumn({ text: longText, actions: [messageAction("OK")] });

    expect(column.text.length).toBe(120);
  });
});

describe("createImageCarousel", () => {
  it("creates an image carousel", () => {
    const columns = [
      createImageCarouselColumn("https://example.com/1.jpg", messageAction("View 1")),
      createImageCarouselColumn("https://example.com/2.jpg", messageAction("View 2")),
    ];
    const template = createImageCarousel(columns);

    expect(template.type).toBe("template");
    expect(template.template.type).toBe("image_carousel");
  });

  it("limits columns to 10", () => {
    const columns = Array.from({ length: 15 }, (_, i) =>
      createImageCarouselColumn(`https://example.com/${i}.jpg`, messageAction("View")),
    );
    const template = createImageCarousel(columns);

    expect((template.template as { columns: unknown[] }).columns.length).toBe(10);
  });
});

describe("createImageCarouselColumn", () => {
  it("creates an image carousel column", () => {
    const action = uriAction("Visit", "https://example.com");
    const column = createImageCarouselColumn("https://example.com/img.jpg", action);

    expect(column.imageUrl).toBe("https://example.com/img.jpg");
    expect(column.action).toBe(action);
  });
});

describe("createYesNoConfirm", () => {
  it("creates a yes/no confirmation with defaults", () => {
    const template = createYesNoConfirm("Continue?");

    expect(template.type).toBe("template");
    expect(template.template.type).toBe("confirm");

    const actions = (template.template as { actions: Array<{ label: string }> }).actions;
    expect(actions[0].label).toBe("Yes");
    expect(actions[1].label).toBe("No");
  });

  it("allows custom button text", () => {
    const template = createYesNoConfirm("Delete?", {
      yesText: "Delete",
      noText: "Cancel",
    });

    const actions = (template.template as { actions: Array<{ label: string }> }).actions;
    expect(actions[0].label).toBe("Delete");
    expect(actions[1].label).toBe("Cancel");
  });

  it("uses postback actions when data provided", () => {
    const template = createYesNoConfirm("Confirm?", {
      yesData: "action=confirm",
      noData: "action=cancel",
    });

    const actions = (template.template as { actions: Array<{ type: string }> }).actions;
    expect(actions[0].type).toBe("postback");
    expect(actions[1].type).toBe("postback");
  });
});

describe("createButtonMenu", () => {
  it("creates a button menu with text buttons", () => {
    const template = createButtonMenu("Menu", "Choose an option", [
      { label: "Option 1" },
      { label: "Option 2", text: "selected option 2" },
    ]);

    expect(template.type).toBe("template");
    expect(template.template.type).toBe("buttons");

    const actions = (template.template as { actions: Array<{ type: string }> }).actions;
    expect(actions.length).toBe(2);
    expect(actions[0].type).toBe("message");
  });
});

describe("createLinkMenu", () => {
  it("creates a button menu with URL links", () => {
    const template = createLinkMenu("Links", "Visit our sites", [
      { label: "Site 1", url: "https://site1.com" },
      { label: "Site 2", url: "https://site2.com" },
    ]);

    expect(template.type).toBe("template");

    const actions = (template.template as { actions: Array<{ type: string }> }).actions;
    expect(actions[0].type).toBe("uri");
    expect(actions[1].type).toBe("uri");
  });
});

describe("createProductCarousel", () => {
  it("creates a product carousel", () => {
    const template = createProductCarousel([
      { title: "Product 1", description: "Desc 1", price: "$10" },
      { title: "Product 2", description: "Desc 2", imageUrl: "https://example.com/p2.jpg" },
    ]);

    expect(template.type).toBe("template");
    expect(template.template.type).toBe("carousel");

    const columns = (template.template as { columns: unknown[] }).columns;
    expect(columns.length).toBe(2);
  });

  it("uses URI action when actionUrl provided", () => {
    const template = createProductCarousel([
      {
        title: "Product",
        description: "Desc",
        actionLabel: "Buy",
        actionUrl: "https://shop.com/buy",
      },
    ]);

    const columns = (template.template as { columns: Array<{ actions: Array<{ type: string }> }> })
      .columns;
    expect(columns[0].actions[0].type).toBe("uri");
  });

  it("uses postback action when actionData provided", () => {
    const template = createProductCarousel([
      {
        title: "Product",
        description: "Desc",
        actionLabel: "Select",
        actionData: "product_id=123",
      },
    ]);

    const columns = (template.template as { columns: Array<{ actions: Array<{ type: string }> }> })
      .columns;
    expect(columns[0].actions[0].type).toBe("postback");
  });

  it("limits to 10 products", () => {
    const products = Array.from({ length: 15 }, (_, i) => ({
      title: `Product ${i}`,
      description: `Desc ${i}`,
    }));
    const template = createProductCarousel(products);

    const columns = (template.template as { columns: unknown[] }).columns;
    expect(columns.length).toBe(10);
  });
});

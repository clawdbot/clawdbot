/*
 Copyright 2025 Google LLC
 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at
      https://www.apache.org/licenses/LICENSE-2.0
 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */
import { SurfaceUpdateSchemaMatcher } from "./surface_update_schema_matcher";
import { SchemaMatcher } from "./schema_matcher";
export function validateSchema(
  data: any,
  schemaName: string,
  matchers?: SchemaMatcher[],
): string[] {
  const errors: string[] = [];
  if (data.surfaceUpdate) {
    validateSurfaceUpdate(data.surfaceUpdate, errors);
  } else if (data.dataModelUpdate) {
    validateDataModelUpdate(data.dataModelUpdate, errors);
  } else if (data.beginRendering) {
    validateBeginRendering(data.beginRendering, errors);
  } else if (data.deleteSurface) {
    validateDeleteSurface(data.deleteSurface, errors);
  } else {
    errors.push(
      "A2UI Protocol message must have one of: surfaceUpdate, dataModelUpdate, beginRendering, deleteSurface.",
    );
  }
  if (matchers) {
    for (const matcher of matchers) {
      const result = matcher.validate(data);
      if (!result.success) {
        errors.push(result.error!);
      }
    }
  }
  return errors;
}
function validateDeleteSurface(data: any, errors: string[]) {
  if (data.surfaceId === undefined) {
    errors.push("DeleteSurface must have a 'surfaceId' property.");
  }
  const allowed = ["surfaceId"];
  for (const key in data) {
    if (!allowed.includes(key)) {
      errors.push(`DeleteSurface has unexpected property: ${key}`);
    }
  }
}
function validateSurfaceUpdate(data: any, errors: string[]) {
  if (data.surfaceId === undefined) {
    errors.push("SurfaceUpdate must have a 'surfaceId' property.");
  }
  if (!data.components || !Array.isArray(data.components)) {
    errors.push("SurfaceUpdate must have a 'components' array.");
    return;
  }
  const componentIds = new Set<string>();
  for (const c of data.components) {
    if (c.id) {
      if (componentIds.has(c.id)) {
        errors.push(`Duplicate component ID found: ${c.id}`);
      }
      componentIds.add(c.id);
    }
  }
  for (const component of data.components) {
    validateComponent(component, componentIds, errors);
  }
}
function validateDataModelUpdate(data: any, errors: string[]) {
  if (data.surfaceId === undefined) {
    errors.push("DataModelUpdate must have a 'surfaceId' property.");
  }
  const allowedTopLevel = ["surfaceId", "path", "contents"];
  for (const key in data) {
    if (!allowedTopLevel.includes(key)) {
      errors.push(`DataModelUpdate has unexpected property: ${key}`);
    }
  }
  if (!Array.isArray(data.contents)) {
    errors.push("DataModelUpdate must have a 'contents' array.");
    return;
  }
  const validateValueProperty = (
    item: any,
    itemErrors: string[],
    prefix: string,
  ) => {
    const valueProps = [
      "valueString",
      "valueNumber",
      "valueBoolean",
      "valueMap",
    ];
    let valueCount = 0;
    let foundValueProp = "";
    for (const prop of valueProps) {
      if (item[prop] !== undefined) {
        valueCount++;
        foundValueProp = prop;
      }
    }
    if (valueCount !== 1) {
      itemErrors.push(
        `${prefix} must have exactly one value property (${valueProps.join(", ")}), found ${valueCount}.`,
      );
      return;
    }
    if (foundValueProp === "valueMap") {
      if (!Array.isArray(item.valueMap)) {
        itemErrors.push(`${prefix} 'valueMap' must be an array.`);
        return;
      }
      item.valueMap.forEach((mapItem: any, index: number) => {
        if (!mapItem.key) {
          itemErrors.push(
            `${prefix} 'valueMap' item at index ${index} is missing a 'key'.`,
          );
        }
        const mapValueProps = ["valueString", "valueNumber", "valueBoolean"];
        let mapValueCount = 0;
        for (const prop of mapValueProps) {
          if (mapItem[prop] !== undefined) {
            mapValueCount++;
          }
        }
        if (mapValueCount !== 1) {
          itemErrors.push(
            `${prefix} 'valueMap' item at index ${index} must have exactly one value property (${mapValueProps.join(", ")}), found ${mapValueCount}.`,
          );
        }
        const allowedMapKeys = ["key", ...mapValueProps];
        for (const key in mapItem) {
          if (!allowedMapKeys.includes(key)) {
            itemErrors.push(
              `${prefix} 'valueMap' item at index ${index} has unexpected property: ${key}`,
            );
          }
        }
      });
    }
  };
  data.contents.forEach((item: any, index: number) => {
    if (!item.key) {
      errors.push(
        `DataModelUpdate 'contents' item at index ${index} is missing a 'key'.`,
      );
    }
    validateValueProperty(
      item,
      errors,
      `DataModelUpdate 'contents' item at index ${index}`,
    );
    const allowedKeys = [
      "key",
      "valueString",
      "valueNumber",
      "valueBoolean",
      "valueMap",
    ];
    for (const key in item) {
      if (!allowedKeys.includes(key)) {
        errors.push(
          `DataModelUpdate 'contents' item at index ${index} has unexpected property: ${key}`,
        );
      }
    }
  });
}
function validateBeginRendering(data: any, errors: string[]) {
  if (data.surfaceId === undefined) {
    errors.push("BeginRendering message must have a 'surfaceId' property.");
  }
  if (!data.root) {
    errors.push("BeginRendering message must have a 'root' property.");
  }
}
function validateBoundValue(
  prop: any,
  propName: string,
  componentId: string,
  componentType: string,
  errors: string[],
) {
  if (typeof prop !== "object" || prop === null || Array.isArray(prop)) {
    errors.push(
      `Component '${componentId}' of type '${componentType}' property '${propName}' must be an object.`,
    );
    return;
  }
  const keys = Object.keys(prop);
  const allowedKeys = [
    "literalString",
    "literalNumber",
    "literalBoolean",
    "path",
  ];
  let validKeyCount = 0;
  for (const key of keys) {
    if (allowedKeys.includes(key)) {
      validKeyCount++;
    }
  }
  if (validKeyCount !== 1 || keys.length !== 1) {
    errors.push(
      `Component '${componentId}' of type '${componentType}' property '${propName}' must have exactly one key from [${allowedKeys.join(", ")}]. Found: ${keys.join(", ")}`,
    );
  }
}
function validateComponent(
  component: any,
  allIds: Set<string>,
  errors: string[],
) {
  if (!component.id) {
    errors.push(`Component is missing an 'id'.`);
    return;
  }
  if (!component.component) {
    errors.push(`Component '${component.id}' is missing 'component'.`);
    return;
  }
  const componentTypes = Object.keys(component.component);
  if (componentTypes.length !== 1) {
    errors.push(
      `Component '${component.id}' must have exactly one property in 'component', but found ${componentTypes.length}.`,
    );
    return;
  }
  const componentType = componentTypes[0];
  const properties = component.component[componentType];
  const checkRequired = (props: string[]) => {
    for (const prop of props) {
      if (properties[prop] === undefined) {
        errors.push(
          `Component '${component.id}' of type '${componentType}' is missing required property '${prop}'.`,
        );
      }
    }
  };
  const checkRefs = (ids: (string | undefined)[]) => {
    for (const id of ids) {
      if (id && !allIds.has(id)) {
        errors.push(
          `Component '${component.id}' references non-existent component ID '${id}'.`,
        );
      }
    }
  };
  switch (componentType) {
    case "Heading":
      checkRequired(["text"]);
      if (properties.text)
        validateBoundValue(
          properties.text,
          "text",
          component.id,
          componentType,
          errors,
        );
      break;
    case "Text":
      checkRequired(["text"]);
      if (properties.text)
        validateBoundValue(
          properties.text,
          "text",
          component.id,
          componentType,
          errors,
        );
      break;
    case "Image":
      checkRequired(["url"]);
      if (properties.url)
        validateBoundValue(
          properties.url,
          "url",
          component.id,
          componentType,
          errors,
        );
      break;
    case "Video":
      checkRequired(["url"]);
      if (properties.url)
        validateBoundValue(
          properties.url,
          "url",
          component.id,
          componentType,
          errors,
        );
      break;
    case "AudioPlayer":
      checkRequired(["url"]);
      if (properties.url)
        validateBoundValue(
          properties.url,
          "url",
          component.id,
          componentType,
          errors,
        );
      if (properties.description)
        validateBoundValue(
          properties.description,
          "description",
          component.id,
          componentType,
          errors,
        );
      break;
    case "TextField":
      checkRequired(["label"]);
      if (properties.label)
        validateBoundValue(
          properties.label,
          "label",
          component.id,
          componentType,
          errors,
        );
      if (properties.text)
        validateBoundValue(
          properties.text,
          "text",
          component.id,
          componentType,
          errors,
        );
      break;
    case "DateTimeInput":
      checkRequired(["value"]);
      if (properties.value)
        validateBoundValue(
          properties.value,
          "value",
          component.id,
          componentType,
          errors,
        );
      break;
    case "MultipleChoice":
      checkRequired(["selections", "options"]);
      if (properties.selections) {
        if (
          typeof properties.selections !== "object" ||
          properties.selections === null ||
          (!properties.selections.literalArray && !properties.selections.path)
        ) {
          errors.push(
            `Component '${component.id}' of type '${componentType}' property 'selections' must have either 'literalArray' or 'path'.`,
          );
        }
      }
      if (Array.isArray(properties.options)) {
        properties.options.forEach((option: any, index: number) => {
          if (!option.label)
            errors.push(
              `Component '${component.id}' option at index ${index} missing 'label'.`,
            );
          if (option.label)
            validateBoundValue(
              option.label,
              "label",
              component.id,
              componentType,
              errors,
            );
          if (!option.value)
            errors.push(
              `Component '${component.id}' option at index ${index} missing 'value'.`,
            );
        });
      }
      break;
    case "Slider":
      checkRequired(["value"]);
      if (properties.value)
        validateBoundValue(
          properties.value,
          "value",
          component.id,
          componentType,
          errors,
        );
      break;
    case "CheckBox":
      checkRequired(["value", "label"]);
      if (properties.value)
        validateBoundValue(
          properties.value,
          "value",
          component.id,
          componentType,
          errors,
        );
      if (properties.label)
        validateBoundValue(
          properties.label,
          "label",
          component.id,
          componentType,
          errors,
        );
      break;
    case "Row":
    case "Column":
    case "List":
      checkRequired(["children"]);
      if (properties.children && Array.isArray(properties.children)) {
        const hasExplicit = !!properties.children.explicitList;
        const hasTemplate = !!properties.children.template;
        if ((hasExplicit && hasTemplate) || (!hasExplicit && !hasTemplate)) {
          errors.push(
            `Component '${component.id}' must have either 'explicitList' or 'template' in children, but not both or neither.`,
          );
        }
        if (hasExplicit) {
          checkRefs(properties.children.explicitList);
        }
        if (hasTemplate) {
          checkRefs([properties.children.template?.componentId]);
        }
      }
      break;
    case "Card":
      checkRequired(["child"]);
      checkRefs([properties.child]);
      break;
    case "Tabs":
      checkRequired(["tabItems"]);
      if (properties.tabItems && Array.isArray(properties.tabItems)) {
        properties.tabItems.forEach((tab: any) => {
          if (!tab.title) {
            errors.push(
              `Tab item in component '${component.id}' is missing a 'title'.`,
            );
          }
          if (!tab.child) {
            errors.push(
              `Tab item in component '${component.id}' is missing a 'child'.`,
            );
          }
          checkRefs([tab.child]);
          if (tab.title)
            validateBoundValue(
              tab.title,
              "title",
              component.id,
              componentType,
              errors,
            );
        });
      }
      break;
    case "Modal":
      checkRequired(["entryPointChild", "contentChild"]);
      checkRefs([properties.entryPointChild, properties.contentChild]);
      break;
    case "Button":
      checkRequired(["child", "action"]);
      checkRefs([properties.child]);
      if (!properties.action || !properties.action.name) {
        errors.push(
          `Component '${component.id}' Button action is missing a 'name'.`,
        );
      }
      break;
    case "Divider":
      // No required properties
      break;
    case "Icon":
      checkRequired(["name"]);
      if (properties.name)
        validateBoundValue(
          properties.name,
          "name",
          component.id,
          componentType,
          errors,
        );
      break;
    default:
      errors.push(
        `Unknown component type '${componentType}' in component '${component.id}'.`,
      );
  }
}

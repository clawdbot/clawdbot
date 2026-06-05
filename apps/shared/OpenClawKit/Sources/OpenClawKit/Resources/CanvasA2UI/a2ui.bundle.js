// Bundled A2UI runtime resource embedded by OpenClawKit.
var __defProp$1 = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp$1(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp$1(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
const eventInit = {
	bubbles: true,
	cancelable: true,
	composed: true
};
var StateEvent = class StateEvent extends CustomEvent {
	static {
		this.eventName = "a2uiaction";
	}
	constructor(payload) {
		super(StateEvent.eventName, {
			detail: payload,
			...eventInit
		});
		this.payload = payload;
	}
};
var guards_exports = /* @__PURE__ */ __exportAll({
	isComponentArrayReference: () => isComponentArrayReference,
	isObject: () => isObject,
	isPath: () => isPath,
	isResolvedAudioPlayer: () => isResolvedAudioPlayer,
	isResolvedButton: () => isResolvedButton,
	isResolvedCard: () => isResolvedCard,
	isResolvedCheckbox: () => isResolvedCheckbox,
	isResolvedColumn: () => isResolvedColumn,
	isResolvedDateTimeInput: () => isResolvedDateTimeInput,
	isResolvedDivider: () => isResolvedDivider,
	isResolvedIcon: () => isResolvedIcon,
	isResolvedImage: () => isResolvedImage,
	isResolvedList: () => isResolvedList,
	isResolvedModal: () => isResolvedModal,
	isResolvedMultipleChoice: () => isResolvedMultipleChoice,
	isResolvedRow: () => isResolvedRow,
	isResolvedSlider: () => isResolvedSlider,
	isResolvedTabs: () => isResolvedTabs,
	isResolvedText: () => isResolvedText,
	isResolvedTextField: () => isResolvedTextField,
	isResolvedVideo: () => isResolvedVideo,
	isValueMap: () => isValueMap
});
function isValueMap(value) {
	return isObject(value) && "key" in value;
}
function isPath(key, value) {
	return key === "path" && typeof value === "string";
}
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isComponentArrayReference(value) {
	if (!isObject(value)) return false;
	return "explicitList" in value || "template" in value;
}
function isStringValue(value) {
	return isObject(value) && ("path" in value || "literal" in value && typeof value.literal === "string" || "literalString" in value);
}
function isNumberValue(value) {
	return isObject(value) && ("path" in value || "literal" in value && typeof value.literal === "number" || "literalNumber" in value);
}
function isBooleanValue(value) {
	return isObject(value) && ("path" in value || "literal" in value && typeof value.literal === "boolean" || "literalBoolean" in value);
}
function isAnyComponentNode(value) {
	if (!isObject(value)) return false;
	if (!("id" in value && "type" in value && "properties" in value)) return false;
	return true;
}
function isResolvedAudioPlayer(props) {
	return isObject(props) && "url" in props && isStringValue(props.url);
}
function isResolvedButton(props) {
	return isObject(props) && "child" in props && isAnyComponentNode(props.child) && "action" in props;
}
function isResolvedCard(props) {
	if (!isObject(props)) return false;
	if (!("child" in props)) if (!("children" in props)) return false;
	else return Array.isArray(props.children) && props.children.every(isAnyComponentNode);
	return isAnyComponentNode(props.child);
}
function isResolvedCheckbox(props) {
	return isObject(props) && "label" in props && isStringValue(props.label) && "value" in props && isBooleanValue(props.value);
}
function isResolvedColumn(props) {
	return isObject(props) && "children" in props && Array.isArray(props.children) && props.children.every(isAnyComponentNode);
}
function isResolvedDateTimeInput(props) {
	return isObject(props) && "value" in props && isStringValue(props.value);
}
function isResolvedDivider(props) {
	return isObject(props);
}
function isResolvedImage(props) {
	return isObject(props) && "url" in props && isStringValue(props.url);
}
function isResolvedIcon(props) {
	return isObject(props) && "name" in props && isStringValue(props.name);
}
function isResolvedList(props) {
	return isObject(props) && "children" in props && Array.isArray(props.children) && props.children.every(isAnyComponentNode);
}
function isResolvedModal(props) {
	return isObject(props) && "entryPointChild" in props && isAnyComponentNode(props.entryPointChild) && "contentChild" in props && isAnyComponentNode(props.contentChild);
}
function isResolvedMultipleChoice(props) {
	return isObject(props) && "selections" in props;
}
function isResolvedRow(props) {
	return isObject(props) && "children" in props && Array.isArray(props.children) && props.children.every(isAnyComponentNode);
}
function isResolvedSlider(props) {
	return isObject(props) && "value" in props && isNumberValue(props.value);
}
function isResolvedTabItem(item) {
	return isObject(item) && "title" in item && isStringValue(item.title) && "child" in item && isAnyComponentNode(item.child);
}
function isResolvedTabs(props) {
	return isObject(props) && "tabItems" in props && Array.isArray(props.tabItems) && props.tabItems.every(isResolvedTabItem);
}
function isResolvedText(props) {
	return isObject(props) && "text" in props && isStringValue(props.text);
}
function isResolvedTextField(props) {
	return isObject(props) && "label" in props && isStringValue(props.label);
}
function isResolvedVideo(props) {
	return isObject(props) && "url" in props && isStringValue(props.url);
}
/**
* Copyright 2025 Google LLC
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*      https://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
/**
* Event dispatched when an input component's validation state is updated.
*/
var A2UIValidationEvent = class A2UIValidationEvent extends CustomEvent {
	static {
		this.EVENT_NAME = "a2ui-validation-input";
	}
	constructor(detail, eventInitDict) {
		super(A2UIValidationEvent.EVENT_NAME, {
			bubbles: true,
			composed: true,
			...eventInitDict,
			detail: {
				...detail,
				eventType: A2UIValidationEvent.EVENT_NAME
			}
		});
	}
};
var util;
(function(util) {
	util.assertEqual = (_) => {};
	function assertIs(_arg) {}
	util.assertIs = assertIs;
	function assertNever(_x) {
		throw new Error();
	}
	util.assertNever = assertNever;
	util.arrayToEnum = (items) => {
		const obj = {};
		for (const item of items) obj[item] = item;
		return obj;
	};
	util.getValidEnumValues = (obj) => {
		const validKeys = util.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
		const filtered = {};
		for (const k of validKeys) filtered[k] = obj[k];
		return util.objectValues(filtered);
	};
	util.objectValues = (obj) => {
		return util.objectKeys(obj).map(function(e) {
			return obj[e];
		});
	};
	util.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
		const keys = [];
		for (const key in object) if (Object.prototype.hasOwnProperty.call(object, key)) keys.push(key);
		return keys;
	};
	util.find = (arr, checker) => {
		for (const item of arr) if (checker(item)) return item;
	};
	util.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
	function joinValues(array, separator = " | ") {
		return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
	}
	util.joinValues = joinValues;
	util.jsonStringifyReplacer = (_, value) => {
		if (typeof value === "bigint") return value.toString();
		return value;
	};
})(util || (util = {}));
var objectUtil;
(function(objectUtil) {
	objectUtil.mergeShapes = (first, second) => {
		return {
			...first,
			...second
		};
	};
})(objectUtil || (objectUtil = {}));
const ZodParsedType = util.arrayToEnum([
	"string",
	"nan",
	"number",
	"integer",
	"float",
	"boolean",
	"date",
	"bigint",
	"symbol",
	"function",
	"undefined",
	"null",
	"array",
	"object",
	"unknown",
	"promise",
	"void",
	"never",
	"map",
	"set"
]);
const getParsedType = (data) => {
	switch (typeof data) {
		case "undefined": return ZodParsedType.undefined;
		case "string": return ZodParsedType.string;
		case "number": return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
		case "boolean": return ZodParsedType.boolean;
		case "function": return ZodParsedType.function;
		case "bigint": return ZodParsedType.bigint;
		case "symbol": return ZodParsedType.symbol;
		case "object":
			if (Array.isArray(data)) return ZodParsedType.array;
			if (data === null) return ZodParsedType.null;
			if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") return ZodParsedType.promise;
			if (typeof Map !== "undefined" && data instanceof Map) return ZodParsedType.map;
			if (typeof Set !== "undefined" && data instanceof Set) return ZodParsedType.set;
			if (typeof Date !== "undefined" && data instanceof Date) return ZodParsedType.date;
			return ZodParsedType.object;
		default: return ZodParsedType.unknown;
	}
};
const ZodIssueCode = util.arrayToEnum([
	"invalid_type",
	"invalid_literal",
	"custom",
	"invalid_union",
	"invalid_union_discriminator",
	"invalid_enum_value",
	"unrecognized_keys",
	"invalid_arguments",
	"invalid_return_type",
	"invalid_date",
	"invalid_string",
	"too_small",
	"too_big",
	"invalid_intersection_types",
	"not_multiple_of",
	"not_finite"
]);
var ZodError = class ZodError extends Error {
	get errors() {
		return this.issues;
	}
	constructor(issues) {
		super();
		this.issues = [];
		this.addIssue = (sub) => {
			this.issues = [...this.issues, sub];
		};
		this.addIssues = (subs = []) => {
			this.issues = [...this.issues, ...subs];
		};
		const actualProto = new.target.prototype;
		if (Object.setPrototypeOf) Object.setPrototypeOf(this, actualProto);
		else this.__proto__ = actualProto;
		this.name = "ZodError";
		this.issues = issues;
	}
	format(_mapper) {
		const mapper = _mapper || function(issue) {
			return issue.message;
		};
		const fieldErrors = { _errors: [] };
		const processError = (error) => {
			for (const issue of error.issues) if (issue.code === "invalid_union") issue.unionErrors.map(processError);
			else if (issue.code === "invalid_return_type") processError(issue.returnTypeError);
			else if (issue.code === "invalid_arguments") processError(issue.argumentsError);
			else if (issue.path.length === 0) fieldErrors._errors.push(mapper(issue));
			else {
				let curr = fieldErrors;
				let i = 0;
				while (i < issue.path.length) {
					const el = issue.path[i];
					if (!(i === issue.path.length - 1)) curr[el] = curr[el] || { _errors: [] };
					else {
						curr[el] = curr[el] || { _errors: [] };
						curr[el]._errors.push(mapper(issue));
					}
					curr = curr[el];
					i++;
				}
			}
		};
		processError(this);
		return fieldErrors;
	}
	static assert(value) {
		if (!(value instanceof ZodError)) throw new Error(`Not a ZodError: ${value}`);
	}
	toString() {
		return this.message;
	}
	get message() {
		return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
	}
	get isEmpty() {
		return this.issues.length === 0;
	}
	flatten(mapper = (issue) => issue.message) {
		const fieldErrors = {};
		const formErrors = [];
		for (const sub of this.issues) if (sub.path.length > 0) {
			const firstEl = sub.path[0];
			fieldErrors[firstEl] = fieldErrors[firstEl] || [];
			fieldErrors[firstEl].push(mapper(sub));
		} else formErrors.push(mapper(sub));
		return {
			formErrors,
			fieldErrors
		};
	}
	get formErrors() {
		return this.flatten();
	}
};
ZodError.create = (issues) => {
	return new ZodError(issues);
};
const errorMap = (issue, _ctx) => {
	let message;
	switch (issue.code) {
		case ZodIssueCode.invalid_type:
			if (issue.received === ZodParsedType.undefined) message = "Required";
			else message = `Expected ${issue.expected}, received ${issue.received}`;
			break;
		case ZodIssueCode.invalid_literal:
			message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
			break;
		case ZodIssueCode.unrecognized_keys:
			message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
			break;
		case ZodIssueCode.invalid_union:
			message = `Invalid input`;
			break;
		case ZodIssueCode.invalid_union_discriminator:
			message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
			break;
		case ZodIssueCode.invalid_enum_value:
			message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
			break;
		case ZodIssueCode.invalid_arguments:
			message = `Invalid function arguments`;
			break;
		case ZodIssueCode.invalid_return_type:
			message = `Invalid function return type`;
			break;
		case ZodIssueCode.invalid_date:
			message = `Invalid date`;
			break;
		case ZodIssueCode.invalid_string:
			if (typeof issue.validation === "object") if ("includes" in issue.validation) {
				message = `Invalid input: must include "${issue.validation.includes}"`;
				if (typeof issue.validation.position === "number") message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
			} else if ("startsWith" in issue.validation) message = `Invalid input: must start with "${issue.validation.startsWith}"`;
			else if ("endsWith" in issue.validation) message = `Invalid input: must end with "${issue.validation.endsWith}"`;
			else util.assertNever(issue.validation);
			else if (issue.validation !== "regex") message = `Invalid ${issue.validation}`;
			else message = "Invalid";
			break;
		case ZodIssueCode.too_small:
			if (issue.type === "array") message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
			else if (issue.type === "string") message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
			else if (issue.type === "number") message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
			else if (issue.type === "bigint") message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
			else if (issue.type === "date") message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
			else message = "Invalid input";
			break;
		case ZodIssueCode.too_big:
			if (issue.type === "array") message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
			else if (issue.type === "string") message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
			else if (issue.type === "number") message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
			else if (issue.type === "bigint") message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
			else if (issue.type === "date") message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
			else message = "Invalid input";
			break;
		case ZodIssueCode.custom:
			message = `Invalid input`;
			break;
		case ZodIssueCode.invalid_intersection_types:
			message = `Intersection results could not be merged`;
			break;
		case ZodIssueCode.not_multiple_of:
			message = `Number must be a multiple of ${issue.multipleOf}`;
			break;
		case ZodIssueCode.not_finite:
			message = "Number must be finite";
			break;
		default:
			message = _ctx.defaultError;
			util.assertNever(issue);
	}
	return { message };
};
let overrideErrorMap = errorMap;
function getErrorMap() {
	return overrideErrorMap;
}
const makeIssue = (params) => {
	const { data, path, errorMaps, issueData } = params;
	const fullPath = [...path, ...issueData.path || []];
	const fullIssue = {
		...issueData,
		path: fullPath
	};
	if (issueData.message !== void 0) return {
		...issueData,
		path: fullPath,
		message: issueData.message
	};
	let errorMessage = "";
	const maps = errorMaps.filter((m) => !!m).slice().reverse();
	for (const map of maps) errorMessage = map(fullIssue, {
		data,
		defaultError: errorMessage
	}).message;
	return {
		...issueData,
		path: fullPath,
		message: errorMessage
	};
};
function addIssueToContext(ctx, issueData) {
	const overrideMap = getErrorMap();
	const issue = makeIssue({
		issueData,
		data: ctx.data,
		path: ctx.path,
		errorMaps: [
			ctx.common.contextualErrorMap,
			ctx.schemaErrorMap,
			overrideMap,
			overrideMap === errorMap ? void 0 : errorMap
		].filter((x) => !!x)
	});
	ctx.common.issues.push(issue);
}
var ParseStatus = class ParseStatus {
	constructor() {
		this.value = "valid";
	}
	dirty() {
		if (this.value === "valid") this.value = "dirty";
	}
	abort() {
		if (this.value !== "aborted") this.value = "aborted";
	}
	static mergeArray(status, results) {
		const arrayValue = [];
		for (const s of results) {
			if (s.status === "aborted") return INVALID;
			if (s.status === "dirty") status.dirty();
			arrayValue.push(s.value);
		}
		return {
			status: status.value,
			value: arrayValue
		};
	}
	static async mergeObjectAsync(status, pairs) {
		const syncPairs = [];
		for (const pair of pairs) {
			const key = await pair.key;
			const value = await pair.value;
			syncPairs.push({
				key,
				value
			});
		}
		return ParseStatus.mergeObjectSync(status, syncPairs);
	}
	static mergeObjectSync(status, pairs) {
		const finalObject = {};
		for (const pair of pairs) {
			const { key, value } = pair;
			if (key.status === "aborted") return INVALID;
			if (value.status === "aborted") return INVALID;
			if (key.status === "dirty") status.dirty();
			if (value.status === "dirty") status.dirty();
			if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) finalObject[key.value] = value.value;
		}
		return {
			status: status.value,
			value: finalObject
		};
	}
};
const INVALID = Object.freeze({ status: "aborted" });
const DIRTY = (value) => ({
	status: "dirty",
	value
});
const OK = (value) => ({
	status: "valid",
	value
});
const isAborted = (x) => x.status === "aborted";
const isDirty = (x) => x.status === "dirty";
const isValid = (x) => x.status === "valid";
const isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;
var errorUtil;
(function(errorUtil) {
	errorUtil.errToObj = (message) => typeof message === "string" ? { message } : message || {};
	errorUtil.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));
var ParseInputLazyPath = class {
	constructor(parent, value, path, key) {
		this._cachedPath = [];
		this.parent = parent;
		this.data = value;
		this._path = path;
		this._key = key;
	}
	get path() {
		if (!this._cachedPath.length) if (Array.isArray(this._key)) this._cachedPath.push(...this._path, ...this._key);
		else this._cachedPath.push(...this._path, this._key);
		return this._cachedPath;
	}
};
const handleResult = (ctx, result) => {
	if (isValid(result)) return {
		success: true,
		data: result.value
	};
	else {
		if (!ctx.common.issues.length) throw new Error("Validation failed but no issues detected.");
		return {
			success: false,
			get error() {
				if (this._error) return this._error;
				const error = new ZodError(ctx.common.issues);
				this._error = error;
				return this._error;
			}
		};
	}
};
function processCreateParams(params) {
	if (!params) return {};
	const { errorMap, invalid_type_error, required_error, description } = params;
	if (errorMap && (invalid_type_error || required_error)) throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
	if (errorMap) return {
		errorMap,
		description
	};
	const customMap = (iss, ctx) => {
		const { message } = params;
		if (iss.code === "invalid_enum_value") return { message: message ?? ctx.defaultError };
		if (typeof ctx.data === "undefined") return { message: message ?? required_error ?? ctx.defaultError };
		if (iss.code !== "invalid_type") return { message: ctx.defaultError };
		return { message: message ?? invalid_type_error ?? ctx.defaultError };
	};
	return {
		errorMap: customMap,
		description
	};
}
var ZodType = class {
	get description() {
		return this._def.description;
	}
	_getType(input) {
		return getParsedType(input.data);
	}
	_getOrReturnCtx(input, ctx) {
		return ctx || {
			common: input.parent.common,
			data: input.data,
			parsedType: getParsedType(input.data),
			schemaErrorMap: this._def.errorMap,
			path: input.path,
			parent: input.parent
		};
	}
	_processInputParams(input) {
		return {
			status: new ParseStatus(),
			ctx: {
				common: input.parent.common,
				data: input.data,
				parsedType: getParsedType(input.data),
				schemaErrorMap: this._def.errorMap,
				path: input.path,
				parent: input.parent
			}
		};
	}
	_parseSync(input) {
		const result = this._parse(input);
		if (isAsync(result)) throw new Error("Synchronous parse encountered promise.");
		return result;
	}
	_parseAsync(input) {
		const result = this._parse(input);
		return Promise.resolve(result);
	}
	parse(data, params) {
		const result = this.safeParse(data, params);
		if (result.success) return result.data;
		throw result.error;
	}
	safeParse(data, params) {
		const ctx = {
			common: {
				issues: [],
				async: params?.async ?? false,
				contextualErrorMap: params?.errorMap
			},
			path: params?.path || [],
			schemaErrorMap: this._def.errorMap,
			parent: null,
			data,
			parsedType: getParsedType(data)
		};
		return handleResult(ctx, this._parseSync({
			data,
			path: ctx.path,
			parent: ctx
		}));
	}
	"~validate"(data) {
		const ctx = {
			common: {
				issues: [],
				async: !!this["~standard"].async
			},
			path: [],
			schemaErrorMap: this._def.errorMap,
			parent: null,
			data,
			parsedType: getParsedType(data)
		};
		if (!this["~standard"].async) try {
			const result = this._parseSync({
				data,
				path: [],
				parent: ctx
			});
			return isValid(result) ? { value: result.value } : { issues: ctx.common.issues };
		} catch (err) {
			if (err?.message?.toLowerCase()?.includes("encountered")) this["~standard"].async = true;
			ctx.common = {
				issues: [],
				async: true
			};
		}
		return this._parseAsync({
			data,
			path: [],
			parent: ctx
		}).then((result) => isValid(result) ? { value: result.value } : { issues: ctx.common.issues });
	}
	async parseAsync(data, params) {
		const result = await this.safeParseAsync(data, params);
		if (result.success) return result.data;
		throw result.error;
	}
	async safeParseAsync(data, params) {
		const ctx = {
			common: {
				issues: [],
				contextualErrorMap: params?.errorMap,
				async: true
			},
			path: params?.path || [],
			schemaErrorMap: this._def.errorMap,
			parent: null,
			data,
			parsedType: getParsedType(data)
		};
		const maybeAsyncResult = this._parse({
			data,
			path: ctx.path,
			parent: ctx
		});
		return handleResult(ctx, await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult)));
	}
	refine(check, message) {
		const getIssueProperties = (val) => {
			if (typeof message === "string" || typeof message === "undefined") return { message };
			else if (typeof message === "function") return message(val);
			else return message;
		};
		return this._refinement((val, ctx) => {
			const result = check(val);
			const setError = () => ctx.addIssue({
				code: ZodIssueCode.custom,
				...getIssueProperties(val)
			});
			if (typeof Promise !== "undefined" && result instanceof Promise) return result.then((data) => {
				if (!data) {
					setError();
					return false;
				} else return true;
			});
			if (!result) {
				setError();
				return false;
			} else return true;
		});
	}
	refinement(check, refinementData) {
		return this._refinement((val, ctx) => {
			if (!check(val)) {
				ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
				return false;
			} else return true;
		});
	}
	_refinement(refinement) {
		return new ZodEffects({
			schema: this,
			typeName: ZodFirstPartyTypeKind.ZodEffects,
			effect: {
				type: "refinement",
				refinement
			}
		});
	}
	superRefine(refinement) {
		return this._refinement(refinement);
	}
	constructor(def) {
		/** Alias of safeParseAsync */
		this.spa = this.safeParseAsync;
		this._def = def;
		this.parse = this.parse.bind(this);
		this.safeParse = this.safeParse.bind(this);
		this.parseAsync = this.parseAsync.bind(this);
		this.safeParseAsync = this.safeParseAsync.bind(this);
		this.spa = this.spa.bind(this);
		this.refine = this.refine.bind(this);
		this.refinement = this.refinement.bind(this);
		this.superRefine = this.superRefine.bind(this);
		this.optional = this.optional.bind(this);
		this.nullable = this.nullable.bind(this);
		this.nullish = this.nullish.bind(this);
		this.array = this.array.bind(this);
		this.promise = this.promise.bind(this);
		this.or = this.or.bind(this);
		this.and = this.and.bind(this);
		this.transform = this.transform.bind(this);
		this.brand = this.brand.bind(this);
		this.default = this.default.bind(this);
		this.catch = this.catch.bind(this);
		this.describe = this.describe.bind(this);
		this.pipe = this.pipe.bind(this);
		this.readonly = this.readonly.bind(this);
		this.isNullable = this.isNullable.bind(this);
		this.isOptional = this.isOptional.bind(this);
		this["~standard"] = {
			version: 1,
			vendor: "zod",
			validate: (data) => this["~validate"](data)
		};
	}
	optional() {
		return ZodOptional.create(this, this._def);
	}
	nullable() {
		return ZodNullable.create(this, this._def);
	}
	nullish() {
		return this.nullable().optional();
	}
	array() {
		return ZodArray.create(this);
	}
	promise() {
		return ZodPromise.create(this, this._def);
	}
	or(option) {
		return ZodUnion.create([this, option], this._def);
	}
	and(incoming) {
		return ZodIntersection.create(this, incoming, this._def);
	}
	transform(transform) {
		return new ZodEffects({
			...processCreateParams(this._def),
			schema: this,
			typeName: ZodFirstPartyTypeKind.ZodEffects,
			effect: {
				type: "transform",
				transform
			}
		});
	}
	default(def) {
		const defaultValueFunc = typeof def === "function" ? def : () => def;
		return new ZodDefault({
			...processCreateParams(this._def),
			innerType: this,
			defaultValue: defaultValueFunc,
			typeName: ZodFirstPartyTypeKind.ZodDefault
		});
	}
	brand() {
		return new ZodBranded({
			typeName: ZodFirstPartyTypeKind.ZodBranded,
			type: this,
			...processCreateParams(this._def)
		});
	}
	catch(def) {
		const catchValueFunc = typeof def === "function" ? def : () => def;
		return new ZodCatch({
			...processCreateParams(this._def),
			innerType: this,
			catchValue: catchValueFunc,
			typeName: ZodFirstPartyTypeKind.ZodCatch
		});
	}
	describe(description) {
		const This = this.constructor;
		return new This({
			...this._def,
			description
		});
	}
	pipe(target) {
		return ZodPipeline.create(this, target);
	}
	readonly() {
		return ZodReadonly.create(this);
	}
	isOptional() {
		return this.safeParse(void 0).success;
	}
	isNullable() {
		return this.safeParse(null).success;
	}
};
const cuidRegex = /^c[^\s-]{8,}$/i;
const cuid2Regex = /^[0-9a-z]+$/;
const ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
const nanoidRegex = /^[a-z0-9_-]{21}$/i;
const jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
const durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
const emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
const _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
let emojiRegex;
const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
const ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
const base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
const base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
const dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
const dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
	let secondsRegexSource = `[0-5]\\d`;
	if (args.precision) secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
	else if (args.precision == null) secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
	const secondsQuantifier = args.precision ? "+" : "?";
	return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
	return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
	let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
	const opts = [];
	opts.push(args.local ? `Z?` : `Z`);
	if (args.offset) opts.push(`([+-]\\d{2}:?\\d{2})`);
	regex = `${regex}(${opts.join("|")})`;
	return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
	if ((version === "v4" || !version) && ipv4Regex.test(ip)) return true;
	if ((version === "v6" || !version) && ipv6Regex.test(ip)) return true;
	return false;
}
function isValidJWT(jwt, alg) {
	if (!jwtRegex.test(jwt)) return false;
	try {
		const [header] = jwt.split(".");
		if (!header) return false;
		const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
		const decoded = JSON.parse(atob(base64));
		if (typeof decoded !== "object" || decoded === null) return false;
		if ("typ" in decoded && decoded?.typ !== "JWT") return false;
		if (!decoded.alg) return false;
		if (alg && decoded.alg !== alg) return false;
		return true;
	} catch {
		return false;
	}
}
function isValidCidr(ip, version) {
	if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) return true;
	if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) return true;
	return false;
}
var ZodString = class ZodString extends ZodType {
	_parse(input) {
		if (this._def.coerce) input.data = String(input.data);
		if (this._getType(input) !== ZodParsedType.string) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.string,
				received: ctx.parsedType
			});
			return INVALID;
		}
		const status = new ParseStatus();
		let ctx = void 0;
		for (const check of this._def.checks) if (check.kind === "min") {
			if (input.data.length < check.value) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_small,
					minimum: check.value,
					type: "string",
					inclusive: true,
					exact: false,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "max") {
			if (input.data.length > check.value) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_big,
					maximum: check.value,
					type: "string",
					inclusive: true,
					exact: false,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "length") {
			const tooBig = input.data.length > check.value;
			const tooSmall = input.data.length < check.value;
			if (tooBig || tooSmall) {
				ctx = this._getOrReturnCtx(input, ctx);
				if (tooBig) addIssueToContext(ctx, {
					code: ZodIssueCode.too_big,
					maximum: check.value,
					type: "string",
					inclusive: true,
					exact: true,
					message: check.message
				});
				else if (tooSmall) addIssueToContext(ctx, {
					code: ZodIssueCode.too_small,
					minimum: check.value,
					type: "string",
					inclusive: true,
					exact: true,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "email") {
			if (!emailRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "email",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "emoji") {
			if (!emojiRegex) emojiRegex = new RegExp(_emojiRegex, "u");
			if (!emojiRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "emoji",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "uuid") {
			if (!uuidRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "uuid",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "nanoid") {
			if (!nanoidRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "nanoid",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "cuid") {
			if (!cuidRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "cuid",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "cuid2") {
			if (!cuid2Regex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "cuid2",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "ulid") {
			if (!ulidRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "ulid",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "url") try {
			new URL(input.data);
		} catch {
			ctx = this._getOrReturnCtx(input, ctx);
			addIssueToContext(ctx, {
				validation: "url",
				code: ZodIssueCode.invalid_string,
				message: check.message
			});
			status.dirty();
		}
		else if (check.kind === "regex") {
			check.regex.lastIndex = 0;
			if (!check.regex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "regex",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "trim") input.data = input.data.trim();
		else if (check.kind === "includes") {
			if (!input.data.includes(check.value, check.position)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.invalid_string,
					validation: {
						includes: check.value,
						position: check.position
					},
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "toLowerCase") input.data = input.data.toLowerCase();
		else if (check.kind === "toUpperCase") input.data = input.data.toUpperCase();
		else if (check.kind === "startsWith") {
			if (!input.data.startsWith(check.value)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.invalid_string,
					validation: { startsWith: check.value },
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "endsWith") {
			if (!input.data.endsWith(check.value)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.invalid_string,
					validation: { endsWith: check.value },
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "datetime") {
			if (!datetimeRegex(check).test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.invalid_string,
					validation: "datetime",
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "date") {
			if (!dateRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.invalid_string,
					validation: "date",
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "time") {
			if (!timeRegex(check).test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.invalid_string,
					validation: "time",
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "duration") {
			if (!durationRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "duration",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "ip") {
			if (!isValidIP(input.data, check.version)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "ip",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "jwt") {
			if (!isValidJWT(input.data, check.alg)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "jwt",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "cidr") {
			if (!isValidCidr(input.data, check.version)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "cidr",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "base64") {
			if (!base64Regex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "base64",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "base64url") {
			if (!base64urlRegex.test(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					validation: "base64url",
					code: ZodIssueCode.invalid_string,
					message: check.message
				});
				status.dirty();
			}
		} else util.assertNever(check);
		return {
			status: status.value,
			value: input.data
		};
	}
	_regex(regex, validation, message) {
		return this.refinement((data) => regex.test(data), {
			validation,
			code: ZodIssueCode.invalid_string,
			...errorUtil.errToObj(message)
		});
	}
	_addCheck(check) {
		return new ZodString({
			...this._def,
			checks: [...this._def.checks, check]
		});
	}
	email(message) {
		return this._addCheck({
			kind: "email",
			...errorUtil.errToObj(message)
		});
	}
	url(message) {
		return this._addCheck({
			kind: "url",
			...errorUtil.errToObj(message)
		});
	}
	emoji(message) {
		return this._addCheck({
			kind: "emoji",
			...errorUtil.errToObj(message)
		});
	}
	uuid(message) {
		return this._addCheck({
			kind: "uuid",
			...errorUtil.errToObj(message)
		});
	}
	nanoid(message) {
		return this._addCheck({
			kind: "nanoid",
			...errorUtil.errToObj(message)
		});
	}
	cuid(message) {
		return this._addCheck({
			kind: "cuid",
			...errorUtil.errToObj(message)
		});
	}
	cuid2(message) {
		return this._addCheck({
			kind: "cuid2",
			...errorUtil.errToObj(message)
		});
	}
	ulid(message) {
		return this._addCheck({
			kind: "ulid",
			...errorUtil.errToObj(message)
		});
	}
	base64(message) {
		return this._addCheck({
			kind: "base64",
			...errorUtil.errToObj(message)
		});
	}
	base64url(message) {
		return this._addCheck({
			kind: "base64url",
			...errorUtil.errToObj(message)
		});
	}
	jwt(options) {
		return this._addCheck({
			kind: "jwt",
			...errorUtil.errToObj(options)
		});
	}
	ip(options) {
		return this._addCheck({
			kind: "ip",
			...errorUtil.errToObj(options)
		});
	}
	cidr(options) {
		return this._addCheck({
			kind: "cidr",
			...errorUtil.errToObj(options)
		});
	}
	datetime(options) {
		if (typeof options === "string") return this._addCheck({
			kind: "datetime",
			precision: null,
			offset: false,
			local: false,
			message: options
		});
		return this._addCheck({
			kind: "datetime",
			precision: typeof options?.precision === "undefined" ? null : options?.precision,
			offset: options?.offset ?? false,
			local: options?.local ?? false,
			...errorUtil.errToObj(options?.message)
		});
	}
	date(message) {
		return this._addCheck({
			kind: "date",
			message
		});
	}
	time(options) {
		if (typeof options === "string") return this._addCheck({
			kind: "time",
			precision: null,
			message: options
		});
		return this._addCheck({
			kind: "time",
			precision: typeof options?.precision === "undefined" ? null : options?.precision,
			...errorUtil.errToObj(options?.message)
		});
	}
	duration(message) {
		return this._addCheck({
			kind: "duration",
			...errorUtil.errToObj(message)
		});
	}
	regex(regex, message) {
		return this._addCheck({
			kind: "regex",
			regex,
			...errorUtil.errToObj(message)
		});
	}
	includes(value, options) {
		return this._addCheck({
			kind: "includes",
			value,
			position: options?.position,
			...errorUtil.errToObj(options?.message)
		});
	}
	startsWith(value, message) {
		return this._addCheck({
			kind: "startsWith",
			value,
			...errorUtil.errToObj(message)
		});
	}
	endsWith(value, message) {
		return this._addCheck({
			kind: "endsWith",
			value,
			...errorUtil.errToObj(message)
		});
	}
	min(minLength, message) {
		return this._addCheck({
			kind: "min",
			value: minLength,
			...errorUtil.errToObj(message)
		});
	}
	max(maxLength, message) {
		return this._addCheck({
			kind: "max",
			value: maxLength,
			...errorUtil.errToObj(message)
		});
	}
	length(len, message) {
		return this._addCheck({
			kind: "length",
			value: len,
			...errorUtil.errToObj(message)
		});
	}
	/**
	* Equivalent to `.min(1)`
	*/
	nonempty(message) {
		return this.min(1, errorUtil.errToObj(message));
	}
	trim() {
		return new ZodString({
			...this._def,
			checks: [...this._def.checks, { kind: "trim" }]
		});
	}
	toLowerCase() {
		return new ZodString({
			...this._def,
			checks: [...this._def.checks, { kind: "toLowerCase" }]
		});
	}
	toUpperCase() {
		return new ZodString({
			...this._def,
			checks: [...this._def.checks, { kind: "toUpperCase" }]
		});
	}
	get isDatetime() {
		return !!this._def.checks.find((ch) => ch.kind === "datetime");
	}
	get isDate() {
		return !!this._def.checks.find((ch) => ch.kind === "date");
	}
	get isTime() {
		return !!this._def.checks.find((ch) => ch.kind === "time");
	}
	get isDuration() {
		return !!this._def.checks.find((ch) => ch.kind === "duration");
	}
	get isEmail() {
		return !!this._def.checks.find((ch) => ch.kind === "email");
	}
	get isURL() {
		return !!this._def.checks.find((ch) => ch.kind === "url");
	}
	get isEmoji() {
		return !!this._def.checks.find((ch) => ch.kind === "emoji");
	}
	get isUUID() {
		return !!this._def.checks.find((ch) => ch.kind === "uuid");
	}
	get isNANOID() {
		return !!this._def.checks.find((ch) => ch.kind === "nanoid");
	}
	get isCUID() {
		return !!this._def.checks.find((ch) => ch.kind === "cuid");
	}
	get isCUID2() {
		return !!this._def.checks.find((ch) => ch.kind === "cuid2");
	}
	get isULID() {
		return !!this._def.checks.find((ch) => ch.kind === "ulid");
	}
	get isIP() {
		return !!this._def.checks.find((ch) => ch.kind === "ip");
	}
	get isCIDR() {
		return !!this._def.checks.find((ch) => ch.kind === "cidr");
	}
	get isBase64() {
		return !!this._def.checks.find((ch) => ch.kind === "base64");
	}
	get isBase64url() {
		return !!this._def.checks.find((ch) => ch.kind === "base64url");
	}
	get minLength() {
		let min = null;
		for (const ch of this._def.checks) if (ch.kind === "min") {
			if (min === null || ch.value > min) min = ch.value;
		}
		return min;
	}
	get maxLength() {
		let max = null;
		for (const ch of this._def.checks) if (ch.kind === "max") {
			if (max === null || ch.value < max) max = ch.value;
		}
		return max;
	}
};
ZodString.create = (params) => {
	return new ZodString({
		checks: [],
		typeName: ZodFirstPartyTypeKind.ZodString,
		coerce: params?.coerce ?? false,
		...processCreateParams(params)
	});
};
function floatSafeRemainder(val, step) {
	const valDecCount = (val.toString().split(".")[1] || "").length;
	const stepDecCount = (step.toString().split(".")[1] || "").length;
	const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
	return Number.parseInt(val.toFixed(decCount).replace(".", "")) % Number.parseInt(step.toFixed(decCount).replace(".", "")) / 10 ** decCount;
}
var ZodNumber = class ZodNumber extends ZodType {
	constructor() {
		super(...arguments);
		this.min = this.gte;
		this.max = this.lte;
		this.step = this.multipleOf;
	}
	_parse(input) {
		if (this._def.coerce) input.data = Number(input.data);
		if (this._getType(input) !== ZodParsedType.number) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.number,
				received: ctx.parsedType
			});
			return INVALID;
		}
		let ctx = void 0;
		const status = new ParseStatus();
		for (const check of this._def.checks) if (check.kind === "int") {
			if (!util.isInteger(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.invalid_type,
					expected: "integer",
					received: "float",
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "min") {
			if (check.inclusive ? input.data < check.value : input.data <= check.value) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_small,
					minimum: check.value,
					type: "number",
					inclusive: check.inclusive,
					exact: false,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "max") {
			if (check.inclusive ? input.data > check.value : input.data >= check.value) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_big,
					maximum: check.value,
					type: "number",
					inclusive: check.inclusive,
					exact: false,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "multipleOf") {
			if (floatSafeRemainder(input.data, check.value) !== 0) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.not_multiple_of,
					multipleOf: check.value,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "finite") {
			if (!Number.isFinite(input.data)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.not_finite,
					message: check.message
				});
				status.dirty();
			}
		} else util.assertNever(check);
		return {
			status: status.value,
			value: input.data
		};
	}
	gte(value, message) {
		return this.setLimit("min", value, true, errorUtil.toString(message));
	}
	gt(value, message) {
		return this.setLimit("min", value, false, errorUtil.toString(message));
	}
	lte(value, message) {
		return this.setLimit("max", value, true, errorUtil.toString(message));
	}
	lt(value, message) {
		return this.setLimit("max", value, false, errorUtil.toString(message));
	}
	setLimit(kind, value, inclusive, message) {
		return new ZodNumber({
			...this._def,
			checks: [...this._def.checks, {
				kind,
				value,
				inclusive,
				message: errorUtil.toString(message)
			}]
		});
	}
	_addCheck(check) {
		return new ZodNumber({
			...this._def,
			checks: [...this._def.checks, check]
		});
	}
	int(message) {
		return this._addCheck({
			kind: "int",
			message: errorUtil.toString(message)
		});
	}
	positive(message) {
		return this._addCheck({
			kind: "min",
			value: 0,
			inclusive: false,
			message: errorUtil.toString(message)
		});
	}
	negative(message) {
		return this._addCheck({
			kind: "max",
			value: 0,
			inclusive: false,
			message: errorUtil.toString(message)
		});
	}
	nonpositive(message) {
		return this._addCheck({
			kind: "max",
			value: 0,
			inclusive: true,
			message: errorUtil.toString(message)
		});
	}
	nonnegative(message) {
		return this._addCheck({
			kind: "min",
			value: 0,
			inclusive: true,
			message: errorUtil.toString(message)
		});
	}
	multipleOf(value, message) {
		return this._addCheck({
			kind: "multipleOf",
			value,
			message: errorUtil.toString(message)
		});
	}
	finite(message) {
		return this._addCheck({
			kind: "finite",
			message: errorUtil.toString(message)
		});
	}
	safe(message) {
		return this._addCheck({
			kind: "min",
			inclusive: true,
			value: Number.MIN_SAFE_INTEGER,
			message: errorUtil.toString(message)
		})._addCheck({
			kind: "max",
			inclusive: true,
			value: Number.MAX_SAFE_INTEGER,
			message: errorUtil.toString(message)
		});
	}
	get minValue() {
		let min = null;
		for (const ch of this._def.checks) if (ch.kind === "min") {
			if (min === null || ch.value > min) min = ch.value;
		}
		return min;
	}
	get maxValue() {
		let max = null;
		for (const ch of this._def.checks) if (ch.kind === "max") {
			if (max === null || ch.value < max) max = ch.value;
		}
		return max;
	}
	get isInt() {
		return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
	}
	get isFinite() {
		let max = null;
		let min = null;
		for (const ch of this._def.checks) if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") return true;
		else if (ch.kind === "min") {
			if (min === null || ch.value > min) min = ch.value;
		} else if (ch.kind === "max") {
			if (max === null || ch.value < max) max = ch.value;
		}
		return Number.isFinite(min) && Number.isFinite(max);
	}
};
ZodNumber.create = (params) => {
	return new ZodNumber({
		checks: [],
		typeName: ZodFirstPartyTypeKind.ZodNumber,
		coerce: params?.coerce || false,
		...processCreateParams(params)
	});
};
var ZodBigInt = class ZodBigInt extends ZodType {
	constructor() {
		super(...arguments);
		this.min = this.gte;
		this.max = this.lte;
	}
	_parse(input) {
		if (this._def.coerce) try {
			input.data = BigInt(input.data);
		} catch {
			return this._getInvalidInput(input);
		}
		if (this._getType(input) !== ZodParsedType.bigint) return this._getInvalidInput(input);
		let ctx = void 0;
		const status = new ParseStatus();
		for (const check of this._def.checks) if (check.kind === "min") {
			if (check.inclusive ? input.data < check.value : input.data <= check.value) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_small,
					type: "bigint",
					minimum: check.value,
					inclusive: check.inclusive,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "max") {
			if (check.inclusive ? input.data > check.value : input.data >= check.value) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_big,
					type: "bigint",
					maximum: check.value,
					inclusive: check.inclusive,
					message: check.message
				});
				status.dirty();
			}
		} else if (check.kind === "multipleOf") {
			if (input.data % check.value !== BigInt(0)) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.not_multiple_of,
					multipleOf: check.value,
					message: check.message
				});
				status.dirty();
			}
		} else util.assertNever(check);
		return {
			status: status.value,
			value: input.data
		};
	}
	_getInvalidInput(input) {
		const ctx = this._getOrReturnCtx(input);
		addIssueToContext(ctx, {
			code: ZodIssueCode.invalid_type,
			expected: ZodParsedType.bigint,
			received: ctx.parsedType
		});
		return INVALID;
	}
	gte(value, message) {
		return this.setLimit("min", value, true, errorUtil.toString(message));
	}
	gt(value, message) {
		return this.setLimit("min", value, false, errorUtil.toString(message));
	}
	lte(value, message) {
		return this.setLimit("max", value, true, errorUtil.toString(message));
	}
	lt(value, message) {
		return this.setLimit("max", value, false, errorUtil.toString(message));
	}
	setLimit(kind, value, inclusive, message) {
		return new ZodBigInt({
			...this._def,
			checks: [...this._def.checks, {
				kind,
				value,
				inclusive,
				message: errorUtil.toString(message)
			}]
		});
	}
	_addCheck(check) {
		return new ZodBigInt({
			...this._def,
			checks: [...this._def.checks, check]
		});
	}
	positive(message) {
		return this._addCheck({
			kind: "min",
			value: BigInt(0),
			inclusive: false,
			message: errorUtil.toString(message)
		});
	}
	negative(message) {
		return this._addCheck({
			kind: "max",
			value: BigInt(0),
			inclusive: false,
			message: errorUtil.toString(message)
		});
	}
	nonpositive(message) {
		return this._addCheck({
			kind: "max",
			value: BigInt(0),
			inclusive: true,
			message: errorUtil.toString(message)
		});
	}
	nonnegative(message) {
		return this._addCheck({
			kind: "min",
			value: BigInt(0),
			inclusive: true,
			message: errorUtil.toString(message)
		});
	}
	multipleOf(value, message) {
		return this._addCheck({
			kind: "multipleOf",
			value,
			message: errorUtil.toString(message)
		});
	}
	get minValue() {
		let min = null;
		for (const ch of this._def.checks) if (ch.kind === "min") {
			if (min === null || ch.value > min) min = ch.value;
		}
		return min;
	}
	get maxValue() {
		let max = null;
		for (const ch of this._def.checks) if (ch.kind === "max") {
			if (max === null || ch.value < max) max = ch.value;
		}
		return max;
	}
};
ZodBigInt.create = (params) => {
	return new ZodBigInt({
		checks: [],
		typeName: ZodFirstPartyTypeKind.ZodBigInt,
		coerce: params?.coerce ?? false,
		...processCreateParams(params)
	});
};
var ZodBoolean = class extends ZodType {
	_parse(input) {
		if (this._def.coerce) input.data = Boolean(input.data);
		if (this._getType(input) !== ZodParsedType.boolean) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.boolean,
				received: ctx.parsedType
			});
			return INVALID;
		}
		return OK(input.data);
	}
};
ZodBoolean.create = (params) => {
	return new ZodBoolean({
		typeName: ZodFirstPartyTypeKind.ZodBoolean,
		coerce: params?.coerce || false,
		...processCreateParams(params)
	});
};
var ZodDate = class ZodDate extends ZodType {
	_parse(input) {
		if (this._def.coerce) input.data = new Date(input.data);
		if (this._getType(input) !== ZodParsedType.date) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.date,
				received: ctx.parsedType
			});
			return INVALID;
		}
		if (Number.isNaN(input.data.getTime())) {
			addIssueToContext(this._getOrReturnCtx(input), { code: ZodIssueCode.invalid_date });
			return INVALID;
		}
		const status = new ParseStatus();
		let ctx = void 0;
		for (const check of this._def.checks) if (check.kind === "min") {
			if (input.data.getTime() < check.value) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_small,
					message: check.message,
					inclusive: true,
					exact: false,
					minimum: check.value,
					type: "date"
				});
				status.dirty();
			}
		} else if (check.kind === "max") {
			if (input.data.getTime() > check.value) {
				ctx = this._getOrReturnCtx(input, ctx);
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_big,
					message: check.message,
					inclusive: true,
					exact: false,
					maximum: check.value,
					type: "date"
				});
				status.dirty();
			}
		} else util.assertNever(check);
		return {
			status: status.value,
			value: new Date(input.data.getTime())
		};
	}
	_addCheck(check) {
		return new ZodDate({
			...this._def,
			checks: [...this._def.checks, check]
		});
	}
	min(minDate, message) {
		return this._addCheck({
			kind: "min",
			value: minDate.getTime(),
			message: errorUtil.toString(message)
		});
	}
	max(maxDate, message) {
		return this._addCheck({
			kind: "max",
			value: maxDate.getTime(),
			message: errorUtil.toString(message)
		});
	}
	get minDate() {
		let min = null;
		for (const ch of this._def.checks) if (ch.kind === "min") {
			if (min === null || ch.value > min) min = ch.value;
		}
		return min != null ? new Date(min) : null;
	}
	get maxDate() {
		let max = null;
		for (const ch of this._def.checks) if (ch.kind === "max") {
			if (max === null || ch.value < max) max = ch.value;
		}
		return max != null ? new Date(max) : null;
	}
};
ZodDate.create = (params) => {
	return new ZodDate({
		checks: [],
		coerce: params?.coerce || false,
		typeName: ZodFirstPartyTypeKind.ZodDate,
		...processCreateParams(params)
	});
};
var ZodSymbol = class extends ZodType {
	_parse(input) {
		if (this._getType(input) !== ZodParsedType.symbol) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.symbol,
				received: ctx.parsedType
			});
			return INVALID;
		}
		return OK(input.data);
	}
};
ZodSymbol.create = (params) => {
	return new ZodSymbol({
		typeName: ZodFirstPartyTypeKind.ZodSymbol,
		...processCreateParams(params)
	});
};
var ZodUndefined = class extends ZodType {
	_parse(input) {
		if (this._getType(input) !== ZodParsedType.undefined) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.undefined,
				received: ctx.parsedType
			});
			return INVALID;
		}
		return OK(input.data);
	}
};
ZodUndefined.create = (params) => {
	return new ZodUndefined({
		typeName: ZodFirstPartyTypeKind.ZodUndefined,
		...processCreateParams(params)
	});
};
var ZodNull = class extends ZodType {
	_parse(input) {
		if (this._getType(input) !== ZodParsedType.null) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.null,
				received: ctx.parsedType
			});
			return INVALID;
		}
		return OK(input.data);
	}
};
ZodNull.create = (params) => {
	return new ZodNull({
		typeName: ZodFirstPartyTypeKind.ZodNull,
		...processCreateParams(params)
	});
};
var ZodAny = class extends ZodType {
	constructor() {
		super(...arguments);
		this._any = true;
	}
	_parse(input) {
		return OK(input.data);
	}
};
ZodAny.create = (params) => {
	return new ZodAny({
		typeName: ZodFirstPartyTypeKind.ZodAny,
		...processCreateParams(params)
	});
};
var ZodUnknown = class extends ZodType {
	constructor() {
		super(...arguments);
		this._unknown = true;
	}
	_parse(input) {
		return OK(input.data);
	}
};
ZodUnknown.create = (params) => {
	return new ZodUnknown({
		typeName: ZodFirstPartyTypeKind.ZodUnknown,
		...processCreateParams(params)
	});
};
var ZodNever = class extends ZodType {
	_parse(input) {
		const ctx = this._getOrReturnCtx(input);
		addIssueToContext(ctx, {
			code: ZodIssueCode.invalid_type,
			expected: ZodParsedType.never,
			received: ctx.parsedType
		});
		return INVALID;
	}
};
ZodNever.create = (params) => {
	return new ZodNever({
		typeName: ZodFirstPartyTypeKind.ZodNever,
		...processCreateParams(params)
	});
};
var ZodVoid = class extends ZodType {
	_parse(input) {
		if (this._getType(input) !== ZodParsedType.undefined) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.void,
				received: ctx.parsedType
			});
			return INVALID;
		}
		return OK(input.data);
	}
};
ZodVoid.create = (params) => {
	return new ZodVoid({
		typeName: ZodFirstPartyTypeKind.ZodVoid,
		...processCreateParams(params)
	});
};
var ZodArray = class ZodArray extends ZodType {
	_parse(input) {
		const { ctx, status } = this._processInputParams(input);
		const def = this._def;
		if (ctx.parsedType !== ZodParsedType.array) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.array,
				received: ctx.parsedType
			});
			return INVALID;
		}
		if (def.exactLength !== null) {
			const tooBig = ctx.data.length > def.exactLength.value;
			const tooSmall = ctx.data.length < def.exactLength.value;
			if (tooBig || tooSmall) {
				addIssueToContext(ctx, {
					code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
					minimum: tooSmall ? def.exactLength.value : void 0,
					maximum: tooBig ? def.exactLength.value : void 0,
					type: "array",
					inclusive: true,
					exact: true,
					message: def.exactLength.message
				});
				status.dirty();
			}
		}
		if (def.minLength !== null) {
			if (ctx.data.length < def.minLength.value) {
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_small,
					minimum: def.minLength.value,
					type: "array",
					inclusive: true,
					exact: false,
					message: def.minLength.message
				});
				status.dirty();
			}
		}
		if (def.maxLength !== null) {
			if (ctx.data.length > def.maxLength.value) {
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_big,
					maximum: def.maxLength.value,
					type: "array",
					inclusive: true,
					exact: false,
					message: def.maxLength.message
				});
				status.dirty();
			}
		}
		if (ctx.common.async) return Promise.all([...ctx.data].map((item, i) => {
			return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
		})).then((result) => {
			return ParseStatus.mergeArray(status, result);
		});
		const result = [...ctx.data].map((item, i) => {
			return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
		});
		return ParseStatus.mergeArray(status, result);
	}
	get element() {
		return this._def.type;
	}
	min(minLength, message) {
		return new ZodArray({
			...this._def,
			minLength: {
				value: minLength,
				message: errorUtil.toString(message)
			}
		});
	}
	max(maxLength, message) {
		return new ZodArray({
			...this._def,
			maxLength: {
				value: maxLength,
				message: errorUtil.toString(message)
			}
		});
	}
	length(len, message) {
		return new ZodArray({
			...this._def,
			exactLength: {
				value: len,
				message: errorUtil.toString(message)
			}
		});
	}
	nonempty(message) {
		return this.min(1, message);
	}
};
ZodArray.create = (schema, params) => {
	return new ZodArray({
		type: schema,
		minLength: null,
		maxLength: null,
		exactLength: null,
		typeName: ZodFirstPartyTypeKind.ZodArray,
		...processCreateParams(params)
	});
};
function deepPartialify(schema) {
	if (schema instanceof ZodObject) {
		const newShape = {};
		for (const key in schema.shape) {
			const fieldSchema = schema.shape[key];
			newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
		}
		return new ZodObject({
			...schema._def,
			shape: () => newShape
		});
	} else if (schema instanceof ZodArray) return new ZodArray({
		...schema._def,
		type: deepPartialify(schema.element)
	});
	else if (schema instanceof ZodOptional) return ZodOptional.create(deepPartialify(schema.unwrap()));
	else if (schema instanceof ZodNullable) return ZodNullable.create(deepPartialify(schema.unwrap()));
	else if (schema instanceof ZodTuple) return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
	else return schema;
}
var ZodObject = class ZodObject extends ZodType {
	constructor() {
		super(...arguments);
		this._cached = null;
		/**
		* @deprecated In most cases, this is no longer needed - unknown properties are now silently stripped.
		* If you want to pass through unknown properties, use `.passthrough()` instead.
		*/
		this.nonstrict = this.passthrough;
		/**
		* @deprecated Use `.extend` instead
		*  */
		this.augment = this.extend;
	}
	_getCached() {
		if (this._cached !== null) return this._cached;
		const shape = this._def.shape();
		const keys = util.objectKeys(shape);
		this._cached = {
			shape,
			keys
		};
		return this._cached;
	}
	_parse(input) {
		if (this._getType(input) !== ZodParsedType.object) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.object,
				received: ctx.parsedType
			});
			return INVALID;
		}
		const { status, ctx } = this._processInputParams(input);
		const { shape, keys: shapeKeys } = this._getCached();
		const extraKeys = [];
		if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
			for (const key in ctx.data) if (!shapeKeys.includes(key)) extraKeys.push(key);
		}
		const pairs = [];
		for (const key of shapeKeys) {
			const keyValidator = shape[key];
			const value = ctx.data[key];
			pairs.push({
				key: {
					status: "valid",
					value: key
				},
				value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
				alwaysSet: key in ctx.data
			});
		}
		if (this._def.catchall instanceof ZodNever) {
			const unknownKeys = this._def.unknownKeys;
			if (unknownKeys === "passthrough") for (const key of extraKeys) pairs.push({
				key: {
					status: "valid",
					value: key
				},
				value: {
					status: "valid",
					value: ctx.data[key]
				}
			});
			else if (unknownKeys === "strict") {
				if (extraKeys.length > 0) {
					addIssueToContext(ctx, {
						code: ZodIssueCode.unrecognized_keys,
						keys: extraKeys
					});
					status.dirty();
				}
			} else if (unknownKeys === "strip") {} else throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
		} else {
			const catchall = this._def.catchall;
			for (const key of extraKeys) {
				const value = ctx.data[key];
				pairs.push({
					key: {
						status: "valid",
						value: key
					},
					value: catchall._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
					alwaysSet: key in ctx.data
				});
			}
		}
		if (ctx.common.async) return Promise.resolve().then(async () => {
			const syncPairs = [];
			for (const pair of pairs) {
				const key = await pair.key;
				const value = await pair.value;
				syncPairs.push({
					key,
					value,
					alwaysSet: pair.alwaysSet
				});
			}
			return syncPairs;
		}).then((syncPairs) => {
			return ParseStatus.mergeObjectSync(status, syncPairs);
		});
		else return ParseStatus.mergeObjectSync(status, pairs);
	}
	get shape() {
		return this._def.shape();
	}
	strict(message) {
		errorUtil.errToObj;
		return new ZodObject({
			...this._def,
			unknownKeys: "strict",
			...message !== void 0 ? { errorMap: (issue, ctx) => {
				const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
				if (issue.code === "unrecognized_keys") return { message: errorUtil.errToObj(message).message ?? defaultError };
				return { message: defaultError };
			} } : {}
		});
	}
	strip() {
		return new ZodObject({
			...this._def,
			unknownKeys: "strip"
		});
	}
	passthrough() {
		return new ZodObject({
			...this._def,
			unknownKeys: "passthrough"
		});
	}
	extend(augmentation) {
		return new ZodObject({
			...this._def,
			shape: () => ({
				...this._def.shape(),
				...augmentation
			})
		});
	}
	/**
	* Prior to zod@1.0.12 there was a bug in the
	* inferred type of merged objects. Please
	* upgrade if you are experiencing issues.
	*/
	merge(merging) {
		return new ZodObject({
			unknownKeys: merging._def.unknownKeys,
			catchall: merging._def.catchall,
			shape: () => ({
				...this._def.shape(),
				...merging._def.shape()
			}),
			typeName: ZodFirstPartyTypeKind.ZodObject
		});
	}
	setKey(key, schema) {
		return this.augment({ [key]: schema });
	}
	catchall(index) {
		return new ZodObject({
			...this._def,
			catchall: index
		});
	}
	pick(mask) {
		const shape = {};
		for (const key of util.objectKeys(mask)) if (mask[key] && this.shape[key]) shape[key] = this.shape[key];
		return new ZodObject({
			...this._def,
			shape: () => shape
		});
	}
	omit(mask) {
		const shape = {};
		for (const key of util.objectKeys(this.shape)) if (!mask[key]) shape[key] = this.shape[key];
		return new ZodObject({
			...this._def,
			shape: () => shape
		});
	}
	/**
	* @deprecated
	*/
	deepPartial() {
		return deepPartialify(this);
	}
	partial(mask) {
		const newShape = {};
		for (const key of util.objectKeys(this.shape)) {
			const fieldSchema = this.shape[key];
			if (mask && !mask[key]) newShape[key] = fieldSchema;
			else newShape[key] = fieldSchema.optional();
		}
		return new ZodObject({
			...this._def,
			shape: () => newShape
		});
	}
	required(mask) {
		const newShape = {};
		for (const key of util.objectKeys(this.shape)) if (mask && !mask[key]) newShape[key] = this.shape[key];
		else {
			let newField = this.shape[key];
			while (newField instanceof ZodOptional) newField = newField._def.innerType;
			newShape[key] = newField;
		}
		return new ZodObject({
			...this._def,
			shape: () => newShape
		});
	}
	keyof() {
		return createZodEnum(util.objectKeys(this.shape));
	}
};
ZodObject.create = (shape, params) => {
	return new ZodObject({
		shape: () => shape,
		unknownKeys: "strip",
		catchall: ZodNever.create(),
		typeName: ZodFirstPartyTypeKind.ZodObject,
		...processCreateParams(params)
	});
};
ZodObject.strictCreate = (shape, params) => {
	return new ZodObject({
		shape: () => shape,
		unknownKeys: "strict",
		catchall: ZodNever.create(),
		typeName: ZodFirstPartyTypeKind.ZodObject,
		...processCreateParams(params)
	});
};
ZodObject.lazycreate = (shape, params) => {
	return new ZodObject({
		shape,
		unknownKeys: "strip",
		catchall: ZodNever.create(),
		typeName: ZodFirstPartyTypeKind.ZodObject,
		...processCreateParams(params)
	});
};
var ZodUnion = class extends ZodType {
	_parse(input) {
		const { ctx } = this._processInputParams(input);
		const options = this._def.options;
		function handleResults(results) {
			for (const result of results) if (result.result.status === "valid") return result.result;
			for (const result of results) if (result.result.status === "dirty") {
				ctx.common.issues.push(...result.ctx.common.issues);
				return result.result;
			}
			const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_union,
				unionErrors
			});
			return INVALID;
		}
		if (ctx.common.async) return Promise.all(options.map(async (option) => {
			const childCtx = {
				...ctx,
				common: {
					...ctx.common,
					issues: []
				},
				parent: null
			};
			return {
				result: await option._parseAsync({
					data: ctx.data,
					path: ctx.path,
					parent: childCtx
				}),
				ctx: childCtx
			};
		})).then(handleResults);
		else {
			let dirty = void 0;
			const issues = [];
			for (const option of options) {
				const childCtx = {
					...ctx,
					common: {
						...ctx.common,
						issues: []
					},
					parent: null
				};
				const result = option._parseSync({
					data: ctx.data,
					path: ctx.path,
					parent: childCtx
				});
				if (result.status === "valid") return result;
				else if (result.status === "dirty" && !dirty) dirty = {
					result,
					ctx: childCtx
				};
				if (childCtx.common.issues.length) issues.push(childCtx.common.issues);
			}
			if (dirty) {
				ctx.common.issues.push(...dirty.ctx.common.issues);
				return dirty.result;
			}
			const unionErrors = issues.map((issues) => new ZodError(issues));
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_union,
				unionErrors
			});
			return INVALID;
		}
	}
	get options() {
		return this._def.options;
	}
};
ZodUnion.create = (types, params) => {
	return new ZodUnion({
		options: types,
		typeName: ZodFirstPartyTypeKind.ZodUnion,
		...processCreateParams(params)
	});
};
const getDiscriminator = (type) => {
	if (type instanceof ZodLazy) return getDiscriminator(type.schema);
	else if (type instanceof ZodEffects) return getDiscriminator(type.innerType());
	else if (type instanceof ZodLiteral) return [type.value];
	else if (type instanceof ZodEnum) return type.options;
	else if (type instanceof ZodNativeEnum) return util.objectValues(type.enum);
	else if (type instanceof ZodDefault) return getDiscriminator(type._def.innerType);
	else if (type instanceof ZodUndefined) return [void 0];
	else if (type instanceof ZodNull) return [null];
	else if (type instanceof ZodOptional) return [void 0, ...getDiscriminator(type.unwrap())];
	else if (type instanceof ZodNullable) return [null, ...getDiscriminator(type.unwrap())];
	else if (type instanceof ZodBranded) return getDiscriminator(type.unwrap());
	else if (type instanceof ZodReadonly) return getDiscriminator(type.unwrap());
	else if (type instanceof ZodCatch) return getDiscriminator(type._def.innerType);
	else return [];
};
var ZodDiscriminatedUnion = class ZodDiscriminatedUnion extends ZodType {
	_parse(input) {
		const { ctx } = this._processInputParams(input);
		if (ctx.parsedType !== ZodParsedType.object) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.object,
				received: ctx.parsedType
			});
			return INVALID;
		}
		const discriminator = this.discriminator;
		const discriminatorValue = ctx.data[discriminator];
		const option = this.optionsMap.get(discriminatorValue);
		if (!option) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_union_discriminator,
				options: Array.from(this.optionsMap.keys()),
				path: [discriminator]
			});
			return INVALID;
		}
		if (ctx.common.async) return option._parseAsync({
			data: ctx.data,
			path: ctx.path,
			parent: ctx
		});
		else return option._parseSync({
			data: ctx.data,
			path: ctx.path,
			parent: ctx
		});
	}
	get discriminator() {
		return this._def.discriminator;
	}
	get options() {
		return this._def.options;
	}
	get optionsMap() {
		return this._def.optionsMap;
	}
	/**
	* The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
	* However, it only allows a union of objects, all of which need to share a discriminator property. This property must
	* have a different value for each object in the union.
	* @param discriminator the name of the discriminator property
	* @param types an array of object schemas
	* @param params
	*/
	static create(discriminator, options, params) {
		const optionsMap = /* @__PURE__ */ new Map();
		for (const type of options) {
			const discriminatorValues = getDiscriminator(type.shape[discriminator]);
			if (!discriminatorValues.length) throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
			for (const value of discriminatorValues) {
				if (optionsMap.has(value)) throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
				optionsMap.set(value, type);
			}
		}
		return new ZodDiscriminatedUnion({
			typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
			discriminator,
			options,
			optionsMap,
			...processCreateParams(params)
		});
	}
};
function mergeValues(a, b) {
	const aType = getParsedType(a);
	const bType = getParsedType(b);
	if (a === b) return {
		valid: true,
		data: a
	};
	else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
		const bKeys = util.objectKeys(b);
		const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
		const newObj = {
			...a,
			...b
		};
		for (const key of sharedKeys) {
			const sharedValue = mergeValues(a[key], b[key]);
			if (!sharedValue.valid) return { valid: false };
			newObj[key] = sharedValue.data;
		}
		return {
			valid: true,
			data: newObj
		};
	} else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
		if (a.length !== b.length) return { valid: false };
		const newArray = [];
		for (let index = 0; index < a.length; index++) {
			const itemA = a[index];
			const itemB = b[index];
			const sharedValue = mergeValues(itemA, itemB);
			if (!sharedValue.valid) return { valid: false };
			newArray.push(sharedValue.data);
		}
		return {
			valid: true,
			data: newArray
		};
	} else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) return {
		valid: true,
		data: a
	};
	else return { valid: false };
}
var ZodIntersection = class extends ZodType {
	_parse(input) {
		const { status, ctx } = this._processInputParams(input);
		const handleParsed = (parsedLeft, parsedRight) => {
			if (isAborted(parsedLeft) || isAborted(parsedRight)) return INVALID;
			const merged = mergeValues(parsedLeft.value, parsedRight.value);
			if (!merged.valid) {
				addIssueToContext(ctx, { code: ZodIssueCode.invalid_intersection_types });
				return INVALID;
			}
			if (isDirty(parsedLeft) || isDirty(parsedRight)) status.dirty();
			return {
				status: status.value,
				value: merged.data
			};
		};
		if (ctx.common.async) return Promise.all([this._def.left._parseAsync({
			data: ctx.data,
			path: ctx.path,
			parent: ctx
		}), this._def.right._parseAsync({
			data: ctx.data,
			path: ctx.path,
			parent: ctx
		})]).then(([left, right]) => handleParsed(left, right));
		else return handleParsed(this._def.left._parseSync({
			data: ctx.data,
			path: ctx.path,
			parent: ctx
		}), this._def.right._parseSync({
			data: ctx.data,
			path: ctx.path,
			parent: ctx
		}));
	}
};
ZodIntersection.create = (left, right, params) => {
	return new ZodIntersection({
		left,
		right,
		typeName: ZodFirstPartyTypeKind.ZodIntersection,
		...processCreateParams(params)
	});
};
var ZodTuple = class ZodTuple extends ZodType {
	_parse(input) {
		const { status, ctx } = this._processInputParams(input);
		if (ctx.parsedType !== ZodParsedType.array) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.array,
				received: ctx.parsedType
			});
			return INVALID;
		}
		if (ctx.data.length < this._def.items.length) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.too_small,
				minimum: this._def.items.length,
				inclusive: true,
				exact: false,
				type: "array"
			});
			return INVALID;
		}
		if (!this._def.rest && ctx.data.length > this._def.items.length) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.too_big,
				maximum: this._def.items.length,
				inclusive: true,
				exact: false,
				type: "array"
			});
			status.dirty();
		}
		const items = [...ctx.data].map((item, itemIndex) => {
			const schema = this._def.items[itemIndex] || this._def.rest;
			if (!schema) return null;
			return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
		}).filter((x) => !!x);
		if (ctx.common.async) return Promise.all(items).then((results) => {
			return ParseStatus.mergeArray(status, results);
		});
		else return ParseStatus.mergeArray(status, items);
	}
	get items() {
		return this._def.items;
	}
	rest(rest) {
		return new ZodTuple({
			...this._def,
			rest
		});
	}
};
ZodTuple.create = (schemas, params) => {
	if (!Array.isArray(schemas)) throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
	return new ZodTuple({
		items: schemas,
		typeName: ZodFirstPartyTypeKind.ZodTuple,
		rest: null,
		...processCreateParams(params)
	});
};
var ZodRecord = class ZodRecord extends ZodType {
	get keySchema() {
		return this._def.keyType;
	}
	get valueSchema() {
		return this._def.valueType;
	}
	_parse(input) {
		const { status, ctx } = this._processInputParams(input);
		if (ctx.parsedType !== ZodParsedType.object) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.object,
				received: ctx.parsedType
			});
			return INVALID;
		}
		const pairs = [];
		const keyType = this._def.keyType;
		const valueType = this._def.valueType;
		for (const key in ctx.data) pairs.push({
			key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
			value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
			alwaysSet: key in ctx.data
		});
		if (ctx.common.async) return ParseStatus.mergeObjectAsync(status, pairs);
		else return ParseStatus.mergeObjectSync(status, pairs);
	}
	get element() {
		return this._def.valueType;
	}
	static create(first, second, third) {
		if (second instanceof ZodType) return new ZodRecord({
			keyType: first,
			valueType: second,
			typeName: ZodFirstPartyTypeKind.ZodRecord,
			...processCreateParams(third)
		});
		return new ZodRecord({
			keyType: ZodString.create(),
			valueType: first,
			typeName: ZodFirstPartyTypeKind.ZodRecord,
			...processCreateParams(second)
		});
	}
};
var ZodMap = class extends ZodType {
	get keySchema() {
		return this._def.keyType;
	}
	get valueSchema() {
		return this._def.valueType;
	}
	_parse(input) {
		const { status, ctx } = this._processInputParams(input);
		if (ctx.parsedType !== ZodParsedType.map) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.map,
				received: ctx.parsedType
			});
			return INVALID;
		}
		const keyType = this._def.keyType;
		const valueType = this._def.valueType;
		const pairs = [...ctx.data.entries()].map(([key, value], index) => {
			return {
				key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
				value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
			};
		});
		if (ctx.common.async) {
			const finalMap = /* @__PURE__ */ new Map();
			return Promise.resolve().then(async () => {
				for (const pair of pairs) {
					const key = await pair.key;
					const value = await pair.value;
					if (key.status === "aborted" || value.status === "aborted") return INVALID;
					if (key.status === "dirty" || value.status === "dirty") status.dirty();
					finalMap.set(key.value, value.value);
				}
				return {
					status: status.value,
					value: finalMap
				};
			});
		} else {
			const finalMap = /* @__PURE__ */ new Map();
			for (const pair of pairs) {
				const key = pair.key;
				const value = pair.value;
				if (key.status === "aborted" || value.status === "aborted") return INVALID;
				if (key.status === "dirty" || value.status === "dirty") status.dirty();
				finalMap.set(key.value, value.value);
			}
			return {
				status: status.value,
				value: finalMap
			};
		}
	}
};
ZodMap.create = (keyType, valueType, params) => {
	return new ZodMap({
		valueType,
		keyType,
		typeName: ZodFirstPartyTypeKind.ZodMap,
		...processCreateParams(params)
	});
};
var ZodSet = class ZodSet extends ZodType {
	_parse(input) {
		const { status, ctx } = this._processInputParams(input);
		if (ctx.parsedType !== ZodParsedType.set) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.set,
				received: ctx.parsedType
			});
			return INVALID;
		}
		const def = this._def;
		if (def.minSize !== null) {
			if (ctx.data.size < def.minSize.value) {
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_small,
					minimum: def.minSize.value,
					type: "set",
					inclusive: true,
					exact: false,
					message: def.minSize.message
				});
				status.dirty();
			}
		}
		if (def.maxSize !== null) {
			if (ctx.data.size > def.maxSize.value) {
				addIssueToContext(ctx, {
					code: ZodIssueCode.too_big,
					maximum: def.maxSize.value,
					type: "set",
					inclusive: true,
					exact: false,
					message: def.maxSize.message
				});
				status.dirty();
			}
		}
		const valueType = this._def.valueType;
		function finalizeSet(elements) {
			const parsedSet = /* @__PURE__ */ new Set();
			for (const element of elements) {
				if (element.status === "aborted") return INVALID;
				if (element.status === "dirty") status.dirty();
				parsedSet.add(element.value);
			}
			return {
				status: status.value,
				value: parsedSet
			};
		}
		const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
		if (ctx.common.async) return Promise.all(elements).then((elements) => finalizeSet(elements));
		else return finalizeSet(elements);
	}
	min(minSize, message) {
		return new ZodSet({
			...this._def,
			minSize: {
				value: minSize,
				message: errorUtil.toString(message)
			}
		});
	}
	max(maxSize, message) {
		return new ZodSet({
			...this._def,
			maxSize: {
				value: maxSize,
				message: errorUtil.toString(message)
			}
		});
	}
	size(size, message) {
		return this.min(size, message).max(size, message);
	}
	nonempty(message) {
		return this.min(1, message);
	}
};
ZodSet.create = (valueType, params) => {
	return new ZodSet({
		valueType,
		minSize: null,
		maxSize: null,
		typeName: ZodFirstPartyTypeKind.ZodSet,
		...processCreateParams(params)
	});
};
var ZodFunction = class ZodFunction extends ZodType {
	constructor() {
		super(...arguments);
		this.validate = this.implement;
	}
	_parse(input) {
		const { ctx } = this._processInputParams(input);
		if (ctx.parsedType !== ZodParsedType.function) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.function,
				received: ctx.parsedType
			});
			return INVALID;
		}
		function makeArgsIssue(args, error) {
			return makeIssue({
				data: args,
				path: ctx.path,
				errorMaps: [
					ctx.common.contextualErrorMap,
					ctx.schemaErrorMap,
					getErrorMap(),
					errorMap
				].filter((x) => !!x),
				issueData: {
					code: ZodIssueCode.invalid_arguments,
					argumentsError: error
				}
			});
		}
		function makeReturnsIssue(returns, error) {
			return makeIssue({
				data: returns,
				path: ctx.path,
				errorMaps: [
					ctx.common.contextualErrorMap,
					ctx.schemaErrorMap,
					getErrorMap(),
					errorMap
				].filter((x) => !!x),
				issueData: {
					code: ZodIssueCode.invalid_return_type,
					returnTypeError: error
				}
			});
		}
		const params = { errorMap: ctx.common.contextualErrorMap };
		const fn = ctx.data;
		if (this._def.returns instanceof ZodPromise) {
			const me = this;
			return OK(async function(...args) {
				const error = new ZodError([]);
				const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
					error.addIssue(makeArgsIssue(args, e));
					throw error;
				});
				const result = await Reflect.apply(fn, this, parsedArgs);
				return await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
					error.addIssue(makeReturnsIssue(result, e));
					throw error;
				});
			});
		} else {
			const me = this;
			return OK(function(...args) {
				const parsedArgs = me._def.args.safeParse(args, params);
				if (!parsedArgs.success) throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
				const result = Reflect.apply(fn, this, parsedArgs.data);
				const parsedReturns = me._def.returns.safeParse(result, params);
				if (!parsedReturns.success) throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
				return parsedReturns.data;
			});
		}
	}
	parameters() {
		return this._def.args;
	}
	returnType() {
		return this._def.returns;
	}
	args(...items) {
		return new ZodFunction({
			...this._def,
			args: ZodTuple.create(items).rest(ZodUnknown.create())
		});
	}
	returns(returnType) {
		return new ZodFunction({
			...this._def,
			returns: returnType
		});
	}
	implement(func) {
		return this.parse(func);
	}
	strictImplement(func) {
		return this.parse(func);
	}
	static create(args, returns, params) {
		return new ZodFunction({
			args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
			returns: returns || ZodUnknown.create(),
			typeName: ZodFirstPartyTypeKind.ZodFunction,
			...processCreateParams(params)
		});
	}
};
var ZodLazy = class extends ZodType {
	get schema() {
		return this._def.getter();
	}
	_parse(input) {
		const { ctx } = this._processInputParams(input);
		return this._def.getter()._parse({
			data: ctx.data,
			path: ctx.path,
			parent: ctx
		});
	}
};
ZodLazy.create = (getter, params) => {
	return new ZodLazy({
		getter,
		typeName: ZodFirstPartyTypeKind.ZodLazy,
		...processCreateParams(params)
	});
};
var ZodLiteral = class extends ZodType {
	_parse(input) {
		if (input.data !== this._def.value) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				received: ctx.data,
				code: ZodIssueCode.invalid_literal,
				expected: this._def.value
			});
			return INVALID;
		}
		return {
			status: "valid",
			value: input.data
		};
	}
	get value() {
		return this._def.value;
	}
};
ZodLiteral.create = (value, params) => {
	return new ZodLiteral({
		value,
		typeName: ZodFirstPartyTypeKind.ZodLiteral,
		...processCreateParams(params)
	});
};
function createZodEnum(values, params) {
	return new ZodEnum({
		values,
		typeName: ZodFirstPartyTypeKind.ZodEnum,
		...processCreateParams(params)
	});
}
var ZodEnum = class ZodEnum extends ZodType {
	_parse(input) {
		if (typeof input.data !== "string") {
			const ctx = this._getOrReturnCtx(input);
			const expectedValues = this._def.values;
			addIssueToContext(ctx, {
				expected: util.joinValues(expectedValues),
				received: ctx.parsedType,
				code: ZodIssueCode.invalid_type
			});
			return INVALID;
		}
		if (!this._cache) this._cache = new Set(this._def.values);
		if (!this._cache.has(input.data)) {
			const ctx = this._getOrReturnCtx(input);
			const expectedValues = this._def.values;
			addIssueToContext(ctx, {
				received: ctx.data,
				code: ZodIssueCode.invalid_enum_value,
				options: expectedValues
			});
			return INVALID;
		}
		return OK(input.data);
	}
	get options() {
		return this._def.values;
	}
	get enum() {
		const enumValues = {};
		for (const val of this._def.values) enumValues[val] = val;
		return enumValues;
	}
	get Values() {
		const enumValues = {};
		for (const val of this._def.values) enumValues[val] = val;
		return enumValues;
	}
	get Enum() {
		const enumValues = {};
		for (const val of this._def.values) enumValues[val] = val;
		return enumValues;
	}
	extract(values, newDef = this._def) {
		return ZodEnum.create(values, {
			...this._def,
			...newDef
		});
	}
	exclude(values, newDef = this._def) {
		return ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
			...this._def,
			...newDef
		});
	}
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
	_parse(input) {
		const nativeEnumValues = util.getValidEnumValues(this._def.values);
		const ctx = this._getOrReturnCtx(input);
		if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
			const expectedValues = util.objectValues(nativeEnumValues);
			addIssueToContext(ctx, {
				expected: util.joinValues(expectedValues),
				received: ctx.parsedType,
				code: ZodIssueCode.invalid_type
			});
			return INVALID;
		}
		if (!this._cache) this._cache = new Set(util.getValidEnumValues(this._def.values));
		if (!this._cache.has(input.data)) {
			const expectedValues = util.objectValues(nativeEnumValues);
			addIssueToContext(ctx, {
				received: ctx.data,
				code: ZodIssueCode.invalid_enum_value,
				options: expectedValues
			});
			return INVALID;
		}
		return OK(input.data);
	}
	get enum() {
		return this._def.values;
	}
};
ZodNativeEnum.create = (values, params) => {
	return new ZodNativeEnum({
		values,
		typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
		...processCreateParams(params)
	});
};
var ZodPromise = class extends ZodType {
	unwrap() {
		return this._def.type;
	}
	_parse(input) {
		const { ctx } = this._processInputParams(input);
		if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.promise,
				received: ctx.parsedType
			});
			return INVALID;
		}
		return OK((ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data)).then((data) => {
			return this._def.type.parseAsync(data, {
				path: ctx.path,
				errorMap: ctx.common.contextualErrorMap
			});
		}));
	}
};
ZodPromise.create = (schema, params) => {
	return new ZodPromise({
		type: schema,
		typeName: ZodFirstPartyTypeKind.ZodPromise,
		...processCreateParams(params)
	});
};
var ZodEffects = class extends ZodType {
	innerType() {
		return this._def.schema;
	}
	sourceType() {
		return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
	}
	_parse(input) {
		const { status, ctx } = this._processInputParams(input);
		const effect = this._def.effect || null;
		const checkCtx = {
			addIssue: (arg) => {
				addIssueToContext(ctx, arg);
				if (arg.fatal) status.abort();
				else status.dirty();
			},
			get path() {
				return ctx.path;
			}
		};
		checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
		if (effect.type === "preprocess") {
			const processed = effect.transform(ctx.data, checkCtx);
			if (ctx.common.async) return Promise.resolve(processed).then(async (processed) => {
				if (status.value === "aborted") return INVALID;
				const result = await this._def.schema._parseAsync({
					data: processed,
					path: ctx.path,
					parent: ctx
				});
				if (result.status === "aborted") return INVALID;
				if (result.status === "dirty") return DIRTY(result.value);
				if (status.value === "dirty") return DIRTY(result.value);
				return result;
			});
			else {
				if (status.value === "aborted") return INVALID;
				const result = this._def.schema._parseSync({
					data: processed,
					path: ctx.path,
					parent: ctx
				});
				if (result.status === "aborted") return INVALID;
				if (result.status === "dirty") return DIRTY(result.value);
				if (status.value === "dirty") return DIRTY(result.value);
				return result;
			}
		}
		if (effect.type === "refinement") {
			const executeRefinement = (acc) => {
				const result = effect.refinement(acc, checkCtx);
				if (ctx.common.async) return Promise.resolve(result);
				if (result instanceof Promise) throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
				return acc;
			};
			if (ctx.common.async === false) {
				const inner = this._def.schema._parseSync({
					data: ctx.data,
					path: ctx.path,
					parent: ctx
				});
				if (inner.status === "aborted") return INVALID;
				if (inner.status === "dirty") status.dirty();
				executeRefinement(inner.value);
				return {
					status: status.value,
					value: inner.value
				};
			} else return this._def.schema._parseAsync({
				data: ctx.data,
				path: ctx.path,
				parent: ctx
			}).then((inner) => {
				if (inner.status === "aborted") return INVALID;
				if (inner.status === "dirty") status.dirty();
				return executeRefinement(inner.value).then(() => {
					return {
						status: status.value,
						value: inner.value
					};
				});
			});
		}
		if (effect.type === "transform") if (ctx.common.async === false) {
			const base = this._def.schema._parseSync({
				data: ctx.data,
				path: ctx.path,
				parent: ctx
			});
			if (!isValid(base)) return INVALID;
			const result = effect.transform(base.value, checkCtx);
			if (result instanceof Promise) throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
			return {
				status: status.value,
				value: result
			};
		} else return this._def.schema._parseAsync({
			data: ctx.data,
			path: ctx.path,
			parent: ctx
		}).then((base) => {
			if (!isValid(base)) return INVALID;
			return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
				status: status.value,
				value: result
			}));
		});
		util.assertNever(effect);
	}
};
ZodEffects.create = (schema, effect, params) => {
	return new ZodEffects({
		schema,
		typeName: ZodFirstPartyTypeKind.ZodEffects,
		effect,
		...processCreateParams(params)
	});
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
	return new ZodEffects({
		schema,
		effect: {
			type: "preprocess",
			transform: preprocess
		},
		typeName: ZodFirstPartyTypeKind.ZodEffects,
		...processCreateParams(params)
	});
};
var ZodOptional = class extends ZodType {
	_parse(input) {
		if (this._getType(input) === ZodParsedType.undefined) return OK(void 0);
		return this._def.innerType._parse(input);
	}
	unwrap() {
		return this._def.innerType;
	}
};
ZodOptional.create = (type, params) => {
	return new ZodOptional({
		innerType: type,
		typeName: ZodFirstPartyTypeKind.ZodOptional,
		...processCreateParams(params)
	});
};
var ZodNullable = class extends ZodType {
	_parse(input) {
		if (this._getType(input) === ZodParsedType.null) return OK(null);
		return this._def.innerType._parse(input);
	}
	unwrap() {
		return this._def.innerType;
	}
};
ZodNullable.create = (type, params) => {
	return new ZodNullable({
		innerType: type,
		typeName: ZodFirstPartyTypeKind.ZodNullable,
		...processCreateParams(params)
	});
};
var ZodDefault = class extends ZodType {
	_parse(input) {
		const { ctx } = this._processInputParams(input);
		let data = ctx.data;
		if (ctx.parsedType === ZodParsedType.undefined) data = this._def.defaultValue();
		return this._def.innerType._parse({
			data,
			path: ctx.path,
			parent: ctx
		});
	}
	removeDefault() {
		return this._def.innerType;
	}
};
ZodDefault.create = (type, params) => {
	return new ZodDefault({
		innerType: type,
		typeName: ZodFirstPartyTypeKind.ZodDefault,
		defaultValue: typeof params.default === "function" ? params.default : () => params.default,
		...processCreateParams(params)
	});
};
var ZodCatch = class extends ZodType {
	_parse(input) {
		const { ctx } = this._processInputParams(input);
		const newCtx = {
			...ctx,
			common: {
				...ctx.common,
				issues: []
			}
		};
		const result = this._def.innerType._parse({
			data: newCtx.data,
			path: newCtx.path,
			parent: { ...newCtx }
		});
		if (isAsync(result)) return result.then((result) => {
			return {
				status: "valid",
				value: result.status === "valid" ? result.value : this._def.catchValue({
					get error() {
						return new ZodError(newCtx.common.issues);
					},
					input: newCtx.data
				})
			};
		});
		else return {
			status: "valid",
			value: result.status === "valid" ? result.value : this._def.catchValue({
				get error() {
					return new ZodError(newCtx.common.issues);
				},
				input: newCtx.data
			})
		};
	}
	removeCatch() {
		return this._def.innerType;
	}
};
ZodCatch.create = (type, params) => {
	return new ZodCatch({
		innerType: type,
		typeName: ZodFirstPartyTypeKind.ZodCatch,
		catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
		...processCreateParams(params)
	});
};
var ZodNaN = class extends ZodType {
	_parse(input) {
		if (this._getType(input) !== ZodParsedType.nan) {
			const ctx = this._getOrReturnCtx(input);
			addIssueToContext(ctx, {
				code: ZodIssueCode.invalid_type,
				expected: ZodParsedType.nan,
				received: ctx.parsedType
			});
			return INVALID;
		}
		return {
			status: "valid",
			value: input.data
		};
	}
};
ZodNaN.create = (params) => {
	return new ZodNaN({
		typeName: ZodFirstPartyTypeKind.ZodNaN,
		...processCreateParams(params)
	});
};
var ZodBranded = class extends ZodType {
	_parse(input) {
		const { ctx } = this._processInputParams(input);
		const data = ctx.data;
		return this._def.type._parse({
			data,
			path: ctx.path,
			parent: ctx
		});
	}
	unwrap() {
		return this._def.type;
	}
};
var ZodPipeline = class ZodPipeline extends ZodType {
	_parse(input) {
		const { status, ctx } = this._processInputParams(input);
		if (ctx.common.async) {
			const handleAsync = async () => {
				const inResult = await this._def.in._parseAsync({
					data: ctx.data,
					path: ctx.path,
					parent: ctx
				});
				if (inResult.status === "aborted") return INVALID;
				if (inResult.status === "dirty") {
					status.dirty();
					return DIRTY(inResult.value);
				} else return this._def.out._parseAsync({
					data: inResult.value,
					path: ctx.path,
					parent: ctx
				});
			};
			return handleAsync();
		} else {
			const inResult = this._def.in._parseSync({
				data: ctx.data,
				path: ctx.path,
				parent: ctx
			});
			if (inResult.status === "aborted") return INVALID;
			if (inResult.status === "dirty") {
				status.dirty();
				return {
					status: "dirty",
					value: inResult.value
				};
			} else return this._def.out._parseSync({
				data: inResult.value,
				path: ctx.path,
				parent: ctx
			});
		}
	}
	static create(a, b) {
		return new ZodPipeline({
			in: a,
			out: b,
			typeName: ZodFirstPartyTypeKind.ZodPipeline
		});
	}
};
var ZodReadonly = class extends ZodType {
	_parse(input) {
		const result = this._def.innerType._parse(input);
		const freeze = (data) => {
			if (isValid(data)) data.value = Object.freeze(data.value);
			return data;
		};
		return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
	}
	unwrap() {
		return this._def.innerType;
	}
};
ZodReadonly.create = (type, params) => {
	return new ZodReadonly({
		innerType: type,
		typeName: ZodFirstPartyTypeKind.ZodReadonly,
		...processCreateParams(params)
	});
};
ZodObject.lazycreate;
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind) {
	ZodFirstPartyTypeKind["ZodString"] = "ZodString";
	ZodFirstPartyTypeKind["ZodNumber"] = "ZodNumber";
	ZodFirstPartyTypeKind["ZodNaN"] = "ZodNaN";
	ZodFirstPartyTypeKind["ZodBigInt"] = "ZodBigInt";
	ZodFirstPartyTypeKind["ZodBoolean"] = "ZodBoolean";
	ZodFirstPartyTypeKind["ZodDate"] = "ZodDate";
	ZodFirstPartyTypeKind["ZodSymbol"] = "ZodSymbol";
	ZodFirstPartyTypeKind["ZodUndefined"] = "ZodUndefined";
	ZodFirstPartyTypeKind["ZodNull"] = "ZodNull";
	ZodFirstPartyTypeKind["ZodAny"] = "ZodAny";
	ZodFirstPartyTypeKind["ZodUnknown"] = "ZodUnknown";
	ZodFirstPartyTypeKind["ZodNever"] = "ZodNever";
	ZodFirstPartyTypeKind["ZodVoid"] = "ZodVoid";
	ZodFirstPartyTypeKind["ZodArray"] = "ZodArray";
	ZodFirstPartyTypeKind["ZodObject"] = "ZodObject";
	ZodFirstPartyTypeKind["ZodUnion"] = "ZodUnion";
	ZodFirstPartyTypeKind["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
	ZodFirstPartyTypeKind["ZodIntersection"] = "ZodIntersection";
	ZodFirstPartyTypeKind["ZodTuple"] = "ZodTuple";
	ZodFirstPartyTypeKind["ZodRecord"] = "ZodRecord";
	ZodFirstPartyTypeKind["ZodMap"] = "ZodMap";
	ZodFirstPartyTypeKind["ZodSet"] = "ZodSet";
	ZodFirstPartyTypeKind["ZodFunction"] = "ZodFunction";
	ZodFirstPartyTypeKind["ZodLazy"] = "ZodLazy";
	ZodFirstPartyTypeKind["ZodLiteral"] = "ZodLiteral";
	ZodFirstPartyTypeKind["ZodEnum"] = "ZodEnum";
	ZodFirstPartyTypeKind["ZodEffects"] = "ZodEffects";
	ZodFirstPartyTypeKind["ZodNativeEnum"] = "ZodNativeEnum";
	ZodFirstPartyTypeKind["ZodOptional"] = "ZodOptional";
	ZodFirstPartyTypeKind["ZodNullable"] = "ZodNullable";
	ZodFirstPartyTypeKind["ZodDefault"] = "ZodDefault";
	ZodFirstPartyTypeKind["ZodCatch"] = "ZodCatch";
	ZodFirstPartyTypeKind["ZodPromise"] = "ZodPromise";
	ZodFirstPartyTypeKind["ZodBranded"] = "ZodBranded";
	ZodFirstPartyTypeKind["ZodPipeline"] = "ZodPipeline";
	ZodFirstPartyTypeKind["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
const stringType = ZodString.create;
const numberType = ZodNumber.create;
ZodNaN.create;
ZodBigInt.create;
const booleanType = ZodBoolean.create;
ZodDate.create;
ZodSymbol.create;
ZodUndefined.create;
ZodNull.create;
const anyType = ZodAny.create;
ZodUnknown.create;
ZodNever.create;
ZodVoid.create;
const arrayType = ZodArray.create;
const objectType = ZodObject.create;
ZodObject.strictCreate;
ZodUnion.create;
ZodDiscriminatedUnion.create;
ZodIntersection.create;
ZodTuple.create;
ZodRecord.create;
ZodMap.create;
ZodSet.create;
ZodFunction.create;
const lazyType = ZodLazy.create;
ZodLiteral.create;
const enumType = ZodEnum.create;
ZodNativeEnum.create;
ZodPromise.create;
ZodEffects.create;
ZodOptional.create;
ZodNullable.create;
ZodEffects.createWithPreprocess;
ZodPipeline.create;
/**
* Copyright 2026 Google LLC
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
/**
* Base primitives
*/
const exactlyOneKey = (val, ctx) => {
	const keys = Object.keys(val).filter((k) => val[k] !== void 0);
	if (keys.length !== 1) ctx.addIssue({
		code: ZodIssueCode.custom,
		message: `Must define exactly one property, found ${keys.length} (${keys.join(", ")}).`
	});
};
const StringValueSchema = objectType({
	path: stringType().optional(),
	literalString: stringType().optional(),
	literal: stringType().optional()
}).strict().superRefine(exactlyOneKey);
const DataValueMapItemSchema = lazyType(() => objectType({
	key: stringType(),
	valueString: stringType().optional(),
	valueNumber: numberType().optional(),
	valueBoolean: booleanType().optional(),
	valueMap: arrayType(DataValueMapItemSchema).optional()
}).strict().superRefine((val, ctx) => {
	let count = 0;
	if (val.valueString !== void 0) count++;
	if (val.valueNumber !== void 0) count++;
	if (val.valueBoolean !== void 0) count++;
	if (val.valueMap !== void 0) count++;
	if (count !== 1) ctx.addIssue({
		code: ZodIssueCode.custom,
		message: `Value map item must have exactly one value property (valueString, valueNumber, valueBoolean, valueMap), found ${count}.`
	});
}));
const DataValueSchema = objectType({
	key: stringType(),
	valueString: stringType().optional(),
	valueNumber: numberType().optional(),
	valueBoolean: booleanType().optional(),
	valueMap: arrayType(DataValueMapItemSchema).optional()
}).strict().superRefine((val, ctx) => {
	let count = 0;
	if (val.valueString !== void 0) count++;
	if (val.valueNumber !== void 0) count++;
	if (val.valueBoolean !== void 0) count++;
	if (val.valueMap !== void 0) count++;
	if (count !== 1) ctx.addIssue({
		code: ZodIssueCode.custom,
		message: `Value must have exactly one value property (valueString, valueNumber, valueBoolean, valueMap), found ${count}.`
	});
}).superRefine((val, ctx) => {
	const checkDepth = (v, currentDepth) => {
		if (currentDepth > 5) {
			ctx.addIssue({
				code: ZodIssueCode.custom,
				message: "valueMap recursion exceeded maximum depth of 5."
			});
			return;
		}
		if (v.valueMap && Array.isArray(v.valueMap)) for (const item of v.valueMap) checkDepth(item, currentDepth + 1);
	};
	checkDepth(val, 1);
});
objectType({
	path: stringType().optional(),
	literalNumber: numberType().optional(),
	literal: numberType().optional()
}).strict().superRefine(exactlyOneKey);
objectType({
	path: stringType().optional(),
	literalBoolean: booleanType().optional(),
	literal: booleanType().optional()
}).strict().superRefine(exactlyOneKey);
/**
* Action Schema for components that trigger user actions
*/
const ActionSchema = objectType({
	name: stringType().describe("A unique name identifying the action (e.g., 'submitForm')."),
	context: arrayType(objectType({
		key: stringType(),
		value: objectType({
			path: stringType().describe("A data binding reference to a location in the data model (e.g., '/user/name').").optional(),
			literalString: stringType().describe("A fixed, hardcoded string value.").optional(),
			literalNumber: numberType().optional(),
			literalBoolean: booleanType().optional()
		}).describe("The dynamic value. Define EXACTLY ONE of the nested properties.").strict().superRefine(exactlyOneKey)
	})).describe("A key-value map of data bindings to be resolved when the action is triggered.").optional()
});
/**
* Component Properties Schemas
*/
const TextSchema = objectType({
	text: StringValueSchema,
	usageHint: enumType([
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"caption",
		"body"
	]).optional()
});
const ImageSchema = objectType({
	url: StringValueSchema,
	usageHint: enumType([
		"icon",
		"avatar",
		"smallFeature",
		"mediumFeature",
		"largeFeature",
		"header"
	]).optional(),
	fit: enumType([
		"contain",
		"cover",
		"fill",
		"none",
		"scale-down"
	]).optional(),
	altText: StringValueSchema.optional()
});
const IconSchema = objectType({ name: StringValueSchema });
const VideoSchema = objectType({ url: StringValueSchema });
const AudioPlayerSchema = objectType({
	url: StringValueSchema,
	description: StringValueSchema.optional().describe("A label, title, or placeholder text.")
});
const TabsSchema = objectType({ tabItems: arrayType(objectType({
	title: objectType({
		path: stringType().describe("A data binding reference to a location in the data model (e.g., '/user/name').").optional(),
		literalString: stringType().describe("A fixed, hardcoded string value.").optional()
	}),
	child: stringType().describe("A reference to a component instance by its unique ID.")
}).strict().superRefine((val, ctx) => {
	if (!val.title) ctx.addIssue({
		code: ZodIssueCode.custom,
		message: "Tab item is missing 'title'."
	});
	if (!val.child) ctx.addIssue({
		code: ZodIssueCode.custom,
		message: "Tab item is missing 'child'."
	});
	if (val.title) exactlyOneKey(val.title, ctx);
})).describe("A list of tabs, each with a title and a child component ID.") });
const DividerSchema = objectType({
	axis: enumType(["horizontal", "vertical"]).optional().describe("The orientation."),
	color: stringType().optional().describe("The color of the divider (e.g., hex code or semantic name)."),
	thickness: numberType().optional().describe("The thickness of the divider.")
});
const ModalSchema = objectType({
	entryPointChild: stringType().describe("The ID of the component (e.g., a button) that triggers the modal."),
	contentChild: stringType().describe("The ID of the component to display as the modal's content.")
});
const ButtonSchema = objectType({
	child: stringType().describe("The ID of the component to display as the button's content."),
	action: ActionSchema.describe("Represents a user-initiated action."),
	primary: booleanType().optional().describe("Indicates if this button should be styled as the primary action.")
});
const CheckboxSchema = objectType({
	label: StringValueSchema,
	value: objectType({
		path: stringType().describe("A data binding reference to a location in the data model (e.g., '/user/name').").optional(),
		literalBoolean: booleanType().optional()
	}).strict().superRefine(exactlyOneKey)
});
const TextFieldSchema = objectType({
	text: StringValueSchema.optional(),
	label: StringValueSchema.describe("A label, title, or placeholder text."),
	textFieldType: enumType([
		"shortText",
		"number",
		"date",
		"longText",
		"obscured"
	]).optional(),
	validationRegexp: stringType().optional().describe("A regex string to validate the input.")
});
const DateTimeInputSchema = objectType({
	value: StringValueSchema,
	enableDate: booleanType().optional(),
	enableTime: booleanType().optional(),
	outputFormat: stringType().optional().describe("The string format for the output (e.g., 'YYYY-MM-DD').")
});
const MultipleChoiceSchema = objectType({
	selections: objectType({
		path: stringType().describe("A data binding reference to a location in the data model (e.g., '/user/name').").optional(),
		literalArray: arrayType(stringType()).optional()
	}).strict().superRefine(exactlyOneKey),
	options: arrayType(objectType({
		label: objectType({
			path: stringType().describe("A data binding reference to a location in the data model (e.g., '/user/name').").optional(),
			literalString: stringType().describe("A fixed, hardcoded string value.").optional()
		}).strict().superRefine(exactlyOneKey),
		value: stringType()
	})).optional(),
	maxAllowedSelections: numberType().optional(),
	type: enumType(["checkbox", "chips"]).optional(),
	filterable: booleanType().optional()
});
const SliderSchema = objectType({
	value: objectType({
		path: stringType().describe("A data binding reference to a location in the data model (e.g., '/user/name').").optional(),
		literalNumber: numberType().optional()
	}).strict().superRefine(exactlyOneKey),
	minValue: numberType().optional(),
	maxValue: numberType().optional(),
	label: StringValueSchema.optional()
});
const ComponentArrayTemplateSchema = objectType({
	componentId: stringType(),
	dataBinding: stringType()
});
const ComponentArrayReferenceSchema = objectType({
	explicitList: arrayType(stringType()).optional(),
	template: ComponentArrayTemplateSchema.describe("A template for generating a dynamic list of children from a data model list. `componentId` is the component to use as a template, and `dataBinding` is the path to the map of components in the data model. Values in the map will define the list of children.").optional()
}).strict().superRefine(exactlyOneKey);
const RowSchema = objectType({
	children: ComponentArrayReferenceSchema,
	distribution: enumType([
		"start",
		"center",
		"end",
		"spaceBetween",
		"spaceAround",
		"spaceEvenly"
	]).optional(),
	alignment: enumType([
		"start",
		"center",
		"end",
		"stretch"
	]).optional()
});
const ColumnSchema = objectType({
	children: ComponentArrayReferenceSchema,
	distribution: enumType([
		"start",
		"center",
		"end",
		"spaceBetween",
		"spaceAround",
		"spaceEvenly"
	]).optional(),
	alignment: enumType([
		"start",
		"center",
		"end",
		"stretch"
	]).optional()
});
const ListSchema = objectType({
	children: ComponentArrayReferenceSchema,
	direction: enumType(["vertical", "horizontal"]).optional(),
	alignment: enumType([
		"start",
		"center",
		"end",
		"stretch"
	]).optional()
});
const CardSchema = objectType({ child: stringType().describe("The ID of the component to be rendered inside the card.") });
const ValueMapSchema = DataValueSchema.describe("A single data entry. Exactly one 'value*' property should be provided alongside the key.");
const ComponentPropertiesSchema = objectType({
	Text: TextSchema.optional(),
	Image: ImageSchema.optional(),
	Icon: IconSchema.optional(),
	Video: VideoSchema.optional(),
	AudioPlayer: AudioPlayerSchema.optional(),
	Row: lazyType(() => RowSchema).optional(),
	Column: lazyType(() => ColumnSchema).optional(),
	List: lazyType(() => ListSchema).optional(),
	Card: lazyType(() => CardSchema).optional(),
	Tabs: TabsSchema.optional(),
	Divider: DividerSchema.optional(),
	Modal: ModalSchema.optional(),
	Button: ButtonSchema.optional(),
	Checkbox: CheckboxSchema.optional(),
	TextField: TextFieldSchema.optional(),
	DateTimeInput: DateTimeInputSchema.optional(),
	MultipleChoice: MultipleChoiceSchema.optional(),
	Slider: SliderSchema.optional()
}).catchall(anyType());
const ComponentInstanceSchema = objectType({
	id: stringType().describe("The unique identifier for this component."),
	weight: numberType().optional().describe("The relative weight of this component within a Row or Column. This corresponds to the CSS 'flex-grow' property. Note: this may ONLY be set when the component is a direct descendant of a Row or Column."),
	component: ComponentPropertiesSchema.describe("A wrapper object that MUST contain exactly one key, which is the name of the component type (e.g., 'Heading'). The value is an object containing the properties for that specific component.")
}).strict().describe("Represents a *single* component in a UI widget tree. This component could be one of many supported types.");
const BeginRenderingMessageSchema = objectType({
	surfaceId: stringType().describe("The unique identifier for the UI surface to be rendered."),
	catalogId: stringType().optional().describe("The identifier of the component catalog to use for this surface. If omitted, the client MUST default to the standard catalog for this A2UI version (https://a2ui.org/specification/v0_8/standard_catalog_definition.json)."),
	root: stringType().describe("The ID of the root component to render."),
	styles: objectType({
		font: stringType().optional().describe("The primary font for the UI."),
		primaryColor: stringType().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("The primary UI color as a hexadecimal code (e.g., '#00BFFF').")
	}).strict().optional().describe("Styling information for the UI.")
}).strict().describe("Signals the client to begin rendering a surface with a root component and specific styles.");
const SurfaceUpdateMessageSchema = objectType({
	surfaceId: stringType().describe("The unique identifier for the UI surface to be updated. If you are adding a new surface this *must* be a new, unique identified that has never been used for any existing surfaces shown."),
	components: arrayType(ComponentInstanceSchema).min(1).describe("A list containing all UI components for the surface.")
}).strict().superRefine((data, ctx) => {
	const componentIds = /* @__PURE__ */ new Set();
	for (const c of data.components) if (c.id) {
		if (componentIds.has(c.id)) ctx.addIssue({
			code: ZodIssueCode.custom,
			message: `Duplicate component ID found: ${c.id}`,
			path: ["components"]
		});
		componentIds.add(c.id);
	}
	const checkRefs = (ids, componentId) => {
		for (const id of ids) if (id && !componentIds.has(id)) ctx.addIssue({
			code: ZodIssueCode.custom,
			message: `Component '${componentId}' references non-existent component ID '${id}'.`,
			path: ["components"]
		});
	};
	for (const component of data.components) {
		if (!component.id || !component.component) continue;
		const componentTypes = Object.keys(component.component);
		if (componentTypes.length !== 1) continue;
		const componentType = componentTypes[0];
		const properties = component.component[componentType];
		switch (componentType) {
			case "Row":
			case "Column":
			case "List":
				if (properties.children && !Array.isArray(properties.children)) {
					const hasExplicit = !!properties.children.explicitList;
					const hasTemplate = !!properties.children.template;
					if (hasExplicit && hasTemplate || !hasExplicit && !hasTemplate) ctx.addIssue({
						code: ZodIssueCode.custom,
						message: `Component '${component.id}' must have either 'explicitList' or 'template' in children, but not both or neither.`
					});
					if (hasExplicit) checkRefs(properties.children.explicitList, component.id);
					if (hasTemplate) checkRefs([properties.children.template?.componentId], component.id);
				}
				break;
			case "Card":
				if (properties.child) checkRefs([properties.child], component.id);
				break;
			case "Tabs":
				if (properties.tabItems && Array.isArray(properties.tabItems)) properties.tabItems.forEach((tab) => {
					if (tab.child) checkRefs([tab.child], component.id);
				});
				break;
			case "Modal":
				checkRefs([properties.entryPointChild, properties.contentChild], component.id);
				break;
			case "Button":
				if (properties.child) checkRefs([properties.child], component.id);
				break;
		}
	}
}).describe("Updates a surface with a new set of components.");
const DataModelUpdateMessageSchema = objectType({
	surfaceId: stringType().describe("The unique identifier for the UI surface this data model update applies to."),
	path: stringType().optional().describe("An optional path to a location within the data model (e.g., '/user/name'). If omitted, or set to '/', the entire data model will be replaced."),
	contents: arrayType(ValueMapSchema).describe("An array of data entries. Each entry must contain a 'key' and exactly one corresponding typed 'value*' property.")
}).strict().describe("Updates the data model for a surface.");
const DeleteSurfaceMessageSchema = objectType({ surfaceId: stringType().describe("The unique identifier for the UI surface to be deleted.") }).strict().describe("Signals the client to delete the surface identified by 'surfaceId'.");
const A2uiMessageSchema = objectType({
	beginRendering: BeginRenderingMessageSchema.optional(),
	surfaceUpdate: SurfaceUpdateMessageSchema.optional(),
	dataModelUpdate: DataModelUpdateMessageSchema.optional(),
	deleteSurface: DeleteSurfaceMessageSchema.optional()
}).strict().superRefine((data, ctx) => {
	if (Object.keys(data).filter((k) => [
		"beginRendering",
		"surfaceUpdate",
		"dataModelUpdate",
		"deleteSurface"
	].includes(k)).length !== 1) ctx.addIssue({
		code: ZodIssueCode.custom,
		message: "A2UI Protocol message must have exactly one of: surfaceUpdate, dataModelUpdate, beginRendering, deleteSurface."
	});
}).describe("Describes a JSON payload for an A2UI (Agent to UI) message, which is used to dynamically construct and update user interfaces. A message MUST contain exactly ONE of the action properties: 'beginRendering', 'surfaceUpdate', 'dataModelUpdate', or 'deleteSurface'.");
/**
* Base class for all A2UI specific errors.
*/
var A2uiError = class extends Error {
	constructor(message, code = "UNKNOWN_ERROR") {
		super(message);
		this.name = this.constructor.name;
		this.code = code;
		if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
	}
};
/**
* Thrown when JSON validation fails or schemas are mismatched.
*/
var A2uiValidationError = class extends A2uiError {
	constructor(message, details) {
		super(message, "VALIDATION_ERROR");
		this.details = details;
	}
};
/**
* Thrown for structural issues in the UI tree (missing surfaces, duplicate components).
*/
var A2uiStateError = class extends A2uiError {
	constructor(message) {
		super(message, "STATE_ERROR");
	}
};
/**
* Processes and consolidates A2UIProtocolMessage objects into a structured,
* hierarchical model of UI surfaces.
*/
var A2uiMessageProcessor = class A2uiMessageProcessor {
	static {
		this.DEFAULT_SURFACE_ID = "@default";
	}
	constructor(opts = {
		mapCtor: Map,
		arrayCtor: Array,
		setCtor: Set,
		objCtor: Object
	}) {
		this.opts = opts;
		this.mapCtor = Map;
		this.arrayCtor = Array;
		this.setCtor = Set;
		this.objCtor = Object;
		this.arrayCtor = opts.arrayCtor;
		this.mapCtor = opts.mapCtor;
		this.setCtor = opts.setCtor;
		this.objCtor = opts.objCtor;
		this.surfaces = new opts.mapCtor();
	}
	getSurfaces() {
		const allSurfaces = this.surfaces;
		const visibleSurfaces = /* @__PURE__ */ new Map();
		for (const [surfaceId, surface] of allSurfaces) if (surface.rootComponentId) visibleSurfaces.set(surfaceId, surface);
		return visibleSurfaces;
	}
	clearSurfaces() {
		this.surfaces.clear();
	}
	processMessages(messages) {
		for (const rawMessage of messages) {
			const message = A2uiMessageSchema.parse(rawMessage);
			if (message.beginRendering) this.handleBeginRendering(message.beginRendering, message.beginRendering.surfaceId);
			if (message.surfaceUpdate) this.handleSurfaceUpdate(message.surfaceUpdate, message.surfaceUpdate.surfaceId);
			if (message.dataModelUpdate) this.handleDataModelUpdate(message.dataModelUpdate, message.dataModelUpdate.surfaceId);
			if (message.deleteSurface) this.handleDeleteSurface(message.deleteSurface);
		}
	}
	/**
	* Retrieves the data for a given component node and a relative path string.
	* This correctly handles the special `.` path, which refers to the node's
	* own data context.
	*/
	getData(node, relativePath, surfaceId = A2uiMessageProcessor.DEFAULT_SURFACE_ID) {
		const surface = this.getOrCreateSurface(surfaceId);
		if (!surface) return null;
		let finalPath;
		if (relativePath === "." || relativePath === "") finalPath = node.dataContextPath ?? "/";
		else finalPath = this.resolvePath(relativePath, node.dataContextPath);
		return this.getDataByPath(surface.dataModel, finalPath);
	}
	setData(node, relativePath, value, surfaceId = A2uiMessageProcessor.DEFAULT_SURFACE_ID) {
		if (!node) {
			console.warn("No component node set");
			return;
		}
		const surface = this.getOrCreateSurface(surfaceId);
		if (!surface) return;
		let finalPath;
		if (relativePath === "." || relativePath === "") finalPath = node.dataContextPath ?? "/";
		else finalPath = this.resolvePath(relativePath, node.dataContextPath);
		this.setDataByPath(surface.dataModel, finalPath, value);
	}
	resolvePath(path, dataContextPath) {
		if (path.startsWith("/")) return path;
		if (dataContextPath && dataContextPath !== "/") return dataContextPath.endsWith("/") ? `${dataContextPath}${path}` : `${dataContextPath}/${path}`;
		return `/${path}`;
	}
	parseIfJsonString(value) {
		if (typeof value !== "string") return value;
		const trimmedValue = value.trim();
		if (trimmedValue.startsWith("{") && trimmedValue.endsWith("}") || trimmedValue.startsWith("[") && trimmedValue.endsWith("]")) try {
			return JSON.parse(value);
		} catch (e) {
			console.warn(`Failed to parse potential JSON string: "${value.substring(0, 50)}..."`, e);
			return value;
		}
		return value;
	}
	/**
	* Converts a specific array format [{key: "...", value_string: "..."}, ...]
	* into a standard Map. It also attempts to parse any string values that
	* appear to be stringified JSON.
	*/
	convertKeyValueArrayToMap(arr) {
		const map = new this.mapCtor();
		for (const item of arr) {
			if (!isObject(item) || !("key" in item)) continue;
			const key = item.key;
			const valueKey = this.findValueKey(item);
			if (!valueKey) continue;
			let value = item[valueKey];
			if (valueKey === "valueMap" && Array.isArray(value)) value = this.convertKeyValueArrayToMap(value);
			else if (typeof value === "string") value = this.parseIfJsonString(value);
			this.setDataByPath(map, key, value);
		}
		return map;
	}
	setDataByPath(root, path, value) {
		if (Array.isArray(value) && (value.length === 0 || isObject(value[0]) && "key" in value[0])) if (value.length === 1 && isObject(value[0]) && value[0].key === ".") {
			const item = value[0];
			const valueKey = this.findValueKey(item);
			if (valueKey) {
				value = item[valueKey];
				if (valueKey === "valueMap" && Array.isArray(value)) value = this.convertKeyValueArrayToMap(value);
				else if (typeof value === "string") value = this.parseIfJsonString(value);
			} else value = this.convertKeyValueArrayToMap(value);
		} else value = this.convertKeyValueArrayToMap(value);
		const segments = this.normalizePath(path).split("/").filter((s) => s);
		if (segments.length === 0) {
			if (value instanceof Map || isObject(value)) {
				if (!(value instanceof Map) && isObject(value)) value = new this.mapCtor(Object.entries(value));
				root.clear();
				for (const [key, v] of value.entries()) root.set(key, v);
			} else console.error("Cannot set root of DataModel to a non-Map value.");
			return;
		}
		let current = root;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			let target;
			if (current instanceof Map) target = current.get(segment);
			else if (Array.isArray(current) && /^\d+$/.test(segment)) target = current[parseInt(segment, 10)];
			if (target === void 0 || typeof target !== "object" || target === null) {
				target = new this.mapCtor();
				if (current instanceof this.mapCtor) current.set(segment, target);
				else if (Array.isArray(current)) current[parseInt(segment, 10)] = target;
			}
			current = target;
		}
		const finalSegment = segments[segments.length - 1];
		const storedValue = value;
		if (current instanceof this.mapCtor) current.set(finalSegment, storedValue);
		else if (Array.isArray(current) && /^\d+$/.test(finalSegment)) current[parseInt(finalSegment, 10)] = storedValue;
	}
	/**
	* Normalizes a path string into a consistent, slash-delimited format.
	* Converts bracket notation and dot notation in a two-pass.
	* e.g., "bookRecommendations[0].title" -> "/bookRecommendations/0/title"
	* e.g., "book.0.title" -> "/book/0/title"
	*/
	normalizePath(path) {
		return "/" + path.replace(/\[(\d+)\]/g, ".$1").split(".").filter((s) => s.length > 0).join("/");
	}
	getDataByPath(root, path) {
		const segments = this.normalizePath(path).split("/").filter((s) => s);
		let current = root;
		for (const segment of segments) {
			if (current === void 0 || current === null) return null;
			if (current instanceof Map) current = current.get(segment);
			else if (Array.isArray(current) && /^\d+$/.test(segment)) current = current[parseInt(segment, 10)];
			else if (isObject(current)) current = current[segment];
			else return null;
		}
		return current;
	}
	getOrCreateSurface(surfaceId) {
		let surface = this.surfaces.get(surfaceId);
		if (!surface) {
			surface = new this.objCtor({
				rootComponentId: null,
				componentTree: null,
				dataModel: new this.mapCtor(),
				components: new this.mapCtor(),
				styles: new this.objCtor()
			});
			this.surfaces.set(surfaceId, surface);
		}
		return surface;
	}
	handleBeginRendering(message, surfaceId) {
		const surface = this.getOrCreateSurface(surfaceId);
		surface.rootComponentId = message.root;
		surface.styles = message.styles ?? {};
		this.rebuildComponentTree(surface);
	}
	handleSurfaceUpdate(message, surfaceId) {
		const surface = this.getOrCreateSurface(surfaceId);
		for (const component of message.components) surface.components.set(component.id, component);
		this.rebuildComponentTree(surface);
	}
	handleDataModelUpdate(message, surfaceId) {
		const surface = this.getOrCreateSurface(surfaceId);
		const path = message.path ?? "/";
		this.setDataByPath(surface.dataModel, path, message.contents);
		this.rebuildComponentTree(surface);
	}
	handleDeleteSurface(message) {
		this.surfaces.delete(message.surfaceId);
	}
	/**
	* Starts at the root component of the surface and builds out the tree
	* recursively. This process involves resolving all properties of the child
	* components, and expanding on any explicit children lists or templates
	* found in the structure.
	*
	* @param surface The surface to be built.
	*/
	rebuildComponentTree(surface) {
		if (!surface.rootComponentId) {
			surface.componentTree = null;
			return;
		}
		const visited = new this.setCtor();
		surface.componentTree = this.buildNodeRecursive(surface.rootComponentId, surface, visited, "/", "");
	}
	/** Finds a value key in a map. */
	findValueKey(value) {
		return Object.keys(value).find((k) => k.startsWith("value"));
	}
	/**
	* Builds out the nodes recursively.
	*/
	buildNodeRecursive(baseComponentId, surface, visited, dataContextPath, idSuffix = "") {
		const fullId = `${baseComponentId}${idSuffix}`;
		const { components } = surface;
		if (!components.has(baseComponentId)) return null;
		if (visited.has(fullId)) throw new A2uiStateError(`Circular dependency for component "${fullId}".`);
		visited.add(fullId);
		const componentData = components.get(baseComponentId);
		const componentProps = componentData.component ?? {};
		const componentType = Object.keys(componentProps)[0];
		const unresolvedProperties = componentProps[componentType];
		const resolvedProperties = new this.objCtor();
		if (isObject(unresolvedProperties)) for (const [key, value] of Object.entries(unresolvedProperties)) resolvedProperties[key] = this.resolvePropertyValue(value, surface, visited, dataContextPath, idSuffix);
		visited.delete(fullId);
		const baseNode = {
			id: fullId,
			dataContextPath,
			weight: componentData.weight ?? "initial"
		};
		switch (componentType) {
			case "Text":
				if (!isResolvedText(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "Text",
					properties: resolvedProperties
				});
			case "Image":
				if (!isResolvedImage(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "Image",
					properties: resolvedProperties
				});
			case "Icon":
				if (!isResolvedIcon(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "Icon",
					properties: resolvedProperties
				});
			case "Video":
				if (!isResolvedVideo(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "Video",
					properties: resolvedProperties
				});
			case "AudioPlayer":
				if (!isResolvedAudioPlayer(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "AudioPlayer",
					properties: resolvedProperties
				});
			case "Row":
				if (!isResolvedRow(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "Row",
					properties: resolvedProperties
				});
			case "Column":
				if (!isResolvedColumn(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "Column",
					properties: resolvedProperties
				});
			case "List":
				if (!isResolvedList(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "List",
					properties: resolvedProperties
				});
			case "Card":
				if (!isResolvedCard(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "Card",
					properties: resolvedProperties
				});
			case "Tabs":
				if (!isResolvedTabs(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "Tabs",
					properties: resolvedProperties
				});
			case "Divider":
				if (!isResolvedDivider(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "Divider",
					properties: resolvedProperties
				});
			case "Modal":
				if (!isResolvedModal(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "Modal",
					properties: resolvedProperties
				});
			case "Button":
				if (!isResolvedButton(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "Button",
					properties: resolvedProperties
				});
			case "CheckBox":
				if (!isResolvedCheckbox(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "CheckBox",
					properties: resolvedProperties
				});
			case "TextField":
				if (!isResolvedTextField(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "TextField",
					properties: resolvedProperties
				});
			case "DateTimeInput":
				if (!isResolvedDateTimeInput(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "DateTimeInput",
					properties: resolvedProperties
				});
			case "MultipleChoice":
				if (!isResolvedMultipleChoice(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "MultipleChoice",
					properties: resolvedProperties
				});
			case "Slider":
				if (!isResolvedSlider(resolvedProperties)) throw new A2uiValidationError(`Invalid data; expected ${componentType}`);
				return new this.objCtor({
					...baseNode,
					type: "Slider",
					properties: resolvedProperties
				});
			default: return new this.objCtor({
				...baseNode,
				type: componentType,
				properties: resolvedProperties
			});
		}
	}
	/**
	* Recursively resolves an individual property value. If a property indicates
	* a child node (a string that matches a component ID), an explicitList of
	* children, or a template, these will be built out here.
	*/
	resolvePropertyValue(value, surface, visited, dataContextPath, idSuffix = "") {
		if (typeof value === "string" && surface.components.has(value)) return this.buildNodeRecursive(value, surface, visited, dataContextPath, idSuffix);
		if (isComponentArrayReference(value)) {
			if (value.explicitList) return value.explicitList.map((id) => this.buildNodeRecursive(id, surface, visited, dataContextPath, idSuffix));
			if (value.template) {
				const fullDataPath = this.resolvePath(value.template.dataBinding, dataContextPath);
				const data = this.getDataByPath(surface.dataModel, fullDataPath);
				const template = value.template;
				if (Array.isArray(data)) return data.map((_, index) => {
					const newSuffix = `:${[...dataContextPath.split("/").filter((segment) => /^\d+$/.test(segment)), index].join(":")}`;
					const childDataContextPath = `${fullDataPath}/${index}`;
					return this.buildNodeRecursive(template.componentId, surface, visited, childDataContextPath, newSuffix);
				});
				if (data instanceof this.mapCtor) return Array.from(data.keys(), (key) => {
					const newSuffix = `:${key}`;
					const childDataContextPath = `${fullDataPath}/${key}`;
					return this.buildNodeRecursive(template.componentId, surface, visited, childDataContextPath, newSuffix);
				});
				return new this.arrayCtor();
			}
		}
		if (Array.isArray(value)) return value.map((item) => this.resolvePropertyValue(item, surface, visited, dataContextPath, idSuffix));
		if (isObject(value)) {
			const newObj = new this.objCtor();
			for (const [key, propValue] of Object.entries(value)) {
				let propertyValue = propValue;
				if (isPath(key, propValue) && dataContextPath !== "/") {
					propertyValue = propValue.replace(/^\.?\/item/, "").replace(/^\.?\/text/, "").replace(/^\.?\/label/, "").replace(/^\.?\//, "");
					newObj[key] = propertyValue;
					continue;
				}
				newObj[key] = this.resolvePropertyValue(propertyValue, surface, visited, dataContextPath, idSuffix);
			}
			return newObj;
		}
		return value;
	}
};
const opacityBehavior = `
  &:not([disabled]) {
    cursor: pointer;
    opacity: var(--opacity, 0);
    transition: opacity var(--speed, 0.2s) cubic-bezier(0, 0, 0.3, 1);

    &:hover,
    &:focus {
      opacity: 1;
    }
  }`;
const behavior = `
  ${new Array(21).fill(0).map((_, idx) => {
	return `.behavior-ho-${idx * 5} {
          --opacity: ${idx / 20};
          ${opacityBehavior}
        }`;
}).join("\n")}

  .behavior-o-s {
    overflow: scroll;
  }

  .behavior-o-a {
    overflow: auto;
  }

  .behavior-o-h {
    overflow: hidden;
  }

  .behavior-sw-n {
    scrollbar-width: none;
  }
`;
const border = `
  ${new Array(25).fill(0).map((_, idx) => {
	return `
        .border-bw-${idx} { border-width: ${idx}px; }
        .border-btw-${idx} { border-top-width: ${idx}px; }
        .border-bbw-${idx} { border-bottom-width: ${idx}px; }
        .border-blw-${idx} { border-left-width: ${idx}px; }
        .border-brw-${idx} { border-right-width: ${idx}px; }

        .border-ow-${idx} { outline-width: ${idx}px; }
        .border-br-${idx} { border-radius: ${idx * 4}px; overflow: hidden;}`;
}).join("\n")}

  .border-br-50pc {
    border-radius: 50%;
  }

  .border-bs-s {
    border-style: solid;
  }
`;
const shades = [
	0,
	5,
	10,
	15,
	20,
	25,
	30,
	35,
	40,
	50,
	60,
	70,
	80,
	90,
	95,
	98,
	99,
	100
];
function merge(...classes) {
	const styles = {};
	for (const clazz of classes) for (const [key, val] of Object.entries(clazz)) {
		const prefix = key.split("-").with(-1, "").join("-");
		const existingKeys = Object.keys(styles).filter((key) => key.startsWith(prefix));
		for (const existingKey of existingKeys) delete styles[existingKey];
		styles[key] = val;
	}
	return styles;
}
function appendToAll(target, exclusions, ...classes) {
	const updatedTarget = structuredClone(target);
	for (const clazz of classes) for (const key of Object.keys(clazz)) {
		const prefix = key.split("-").with(-1, "").join("-");
		for (const [tagName, classesToAdd] of Object.entries(updatedTarget)) {
			if (exclusions.includes(tagName)) continue;
			let found = false;
			for (let t = 0; t < classesToAdd.length; t++) if (classesToAdd[t].startsWith(prefix)) {
				found = true;
				classesToAdd[t] = key;
			}
			if (!found) classesToAdd.push(key);
		}
	}
	return updatedTarget;
}
function toProp(key) {
	if (key.startsWith("nv")) return `--nv-${key.slice(2)}`;
	return `--${key[0]}-${key.slice(1)}`;
}
const color = (src) => `
    ${src.map((key) => {
	const inverseKey = getInverseKey(key);
	return `.color-bc-${key} { border-color: light-dark(var(${toProp(key)}), var(${toProp(inverseKey)})); }`;
}).join("\n")}

    ${src.map((key) => {
	const inverseKey = getInverseKey(key);
	const vals = [`.color-bgc-${key} { background-color: light-dark(var(${toProp(key)}), var(${toProp(inverseKey)})); }`, `.color-bbgc-${key}::backdrop { background-color: light-dark(var(${toProp(key)}), var(${toProp(inverseKey)})); }`];
	for (let o = .1; o < 1; o += .1) vals.push(`.color-bbgc-${key}_${(o * 100).toFixed(0)}::backdrop {
            background-color: light-dark(oklch(from var(${toProp(key)}) l c h / calc(alpha * ${o.toFixed(1)})), oklch(from var(${toProp(inverseKey)}) l c h / calc(alpha * ${o.toFixed(1)})) );
          }
        `);
	return vals.join("\n");
}).join("\n")}

  ${src.map((key) => {
	const inverseKey = getInverseKey(key);
	return `.color-c-${key} { color: light-dark(var(${toProp(key)}), var(${toProp(inverseKey)})); }`;
}).join("\n")}
  `;
const getInverseKey = (key) => {
	const match = key.match(/^([a-z]+)(\d+)$/);
	if (!match) return key;
	const [, prefix, shadeStr] = match;
	const target = 100 - parseInt(shadeStr, 10);
	return `${prefix}${shades.reduce((prev, curr) => Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev)}`;
};
const keyFactory = (prefix) => {
	return shades.map((v) => `${prefix}${v}`);
};
const structuralStyles$1 = [
	behavior,
	border,
	[
		color(keyFactory("p")),
		color(keyFactory("s")),
		color(keyFactory("t")),
		color(keyFactory("n")),
		color(keyFactory("nv")),
		color(keyFactory("e")),
		`
    .color-bgc-transparent {
      background-color: transparent;
    }

    :host {
      color-scheme: var(--color-scheme);
    }
  `
	],
	`
  .g-icon {
    font-family: "Material Symbols Outlined", "Google Symbols";
    font-weight: normal;
    font-style: normal;
    font-display: optional;
    font-size: 24px;
    width: 1em;
    height: 1em;
    user-select: none;
    line-height: 1;
    letter-spacing: normal;
    text-transform: none;
    display: inline-block;
    white-space: nowrap;
    word-wrap: normal;
    direction: ltr;
    font-feature-settings: "liga";
    -webkit-font-feature-settings: "liga";
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    -moz-osx-font-smoothing: grayscale;
    overflow: hidden;

    font-variation-settings: "FILL" 0, "wght" 300, "GRAD" 0, "opsz" 48,
      "ROND" 100;

    &.filled {
      font-variation-settings: "FILL" 1, "wght" 300, "GRAD" 0, "opsz" 48,
        "ROND" 100;
    }

    &.filled-heavy {
      font-variation-settings: "FILL" 1, "wght" 700, "GRAD" 0, "opsz" 48,
        "ROND" 100;
    }
  }
`,
	`
  :host {
    ${new Array(16).fill(0).map((_, idx) => {
		return `--g-${idx + 1}: ${(idx + 1) * 4}px;`;
	}).join("\n")}
  }

  ${new Array(49).fill(0).map((_, index) => {
		const idx = index - 24;
		const lbl = idx < 0 ? `n${Math.abs(idx)}` : idx.toString();
		return `
        .layout-p-${lbl} { --padding: ${idx * 4}px; padding: var(--padding); }
        .layout-pt-${lbl} { padding-top: ${idx * 4}px; }
        .layout-pr-${lbl} { padding-right: ${idx * 4}px; }
        .layout-pb-${lbl} { padding-bottom: ${idx * 4}px; }
        .layout-pl-${lbl} { padding-left: ${idx * 4}px; }

        .layout-m-${lbl} { --margin: ${idx * 4}px; margin: var(--margin); }
        .layout-mt-${lbl} { margin-top: ${idx * 4}px; }
        .layout-mr-${lbl} { margin-right: ${idx * 4}px; }
        .layout-mb-${lbl} { margin-bottom: ${idx * 4}px; }
        .layout-ml-${lbl} { margin-left: ${idx * 4}px; }

        .layout-t-${lbl} { top: ${idx * 4}px; }
        .layout-r-${lbl} { right: ${idx * 4}px; }
        .layout-b-${lbl} { bottom: ${idx * 4}px; }
        .layout-l-${lbl} { left: ${idx * 4}px; }`;
	}).join("\n")}

  ${new Array(25).fill(0).map((_, idx) => {
		return `
        .layout-g-${idx} { gap: ${idx * 4}px; }`;
	}).join("\n")}

  ${new Array(8).fill(0).map((_, idx) => {
		return `
        .layout-grd-col${idx + 1} { grid-template-columns: ${"1fr ".repeat(idx + 1).trim()}; }`;
	}).join("\n")}

  .layout-pos-a {
    position: absolute;
  }

  .layout-pos-rel {
    position: relative;
  }

  .layout-dsp-none {
    display: none;
  }

  .layout-dsp-block {
    display: block;
  }

  .layout-dsp-grid {
    display: grid;
  }

  .layout-dsp-iflex {
    display: inline-flex;
  }

  .layout-dsp-flexvert {
    display: flex;
    flex-direction: column;
  }

  .layout-dsp-flexhor {
    display: flex;
    flex-direction: row;
  }

  .layout-fw-w {
    flex-wrap: wrap;
  }

  .layout-al-fs {
    align-items: start;
  }

  .layout-al-fe {
    align-items: end;
  }

  .layout-al-c {
    align-items: center;
  }

  .layout-as-n {
    align-self: normal;
  }

  .layout-js-c {
    justify-self: center;
  }

  .layout-sp-c {
    justify-content: center;
  }

  .layout-sp-ev {
    justify-content: space-evenly;
  }

  .layout-sp-bt {
    justify-content: space-between;
  }

  .layout-sp-s {
    justify-content: start;
  }

  .layout-sp-e {
    justify-content: end;
  }

  .layout-ji-e {
    justify-items: end;
  }

  .layout-r-none {
    resize: none;
  }

  .layout-fs-c {
    field-sizing: content;
  }

  .layout-fs-n {
    field-sizing: none;
  }

  .layout-flx-0 {
    flex: 0 0 auto;
  }

  .layout-flx-1 {
    flex: 1 0 auto;
  }

  .layout-c-s {
    contain: strict;
  }

  /** Widths **/

  ${new Array(10).fill(0).map((_, idx) => {
		const weight = (idx + 1) * 10;
		return `.layout-w-${weight} { width: ${weight}%; max-width: ${weight}%; }`;
	}).join("\n")}

  ${new Array(16).fill(0).map((_, idx) => {
		return `.layout-wp-${idx} { width: ${idx * 4}px; }`;
	}).join("\n")}

  /** Heights **/

  ${new Array(10).fill(0).map((_, idx) => {
		const height = (idx + 1) * 10;
		return `.layout-h-${height} { height: ${height}%; }`;
	}).join("\n")}

  ${new Array(16).fill(0).map((_, idx) => {
		return `.layout-hp-${idx} { height: ${idx * 4}px; }`;
	}).join("\n")}

  .layout-el-cv {
    & img,
    & video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      margin: 0;
    }
  }

  .layout-ar-sq {
    aspect-ratio: 1 / 1;
  }

  .layout-ex-fb {
    margin: calc(var(--padding) * -1) 0 0 calc(var(--padding) * -1);
    width: calc(100% + var(--padding) * 2);
    height: calc(100% + var(--padding) * 2);
  }
`,
	`
  ${new Array(21).fill(0).map((_, idx) => {
		return `.opacity-el-${idx * 5} { opacity: ${idx / 20}; }`;
	}).join("\n")}
`,
	`
  :host {
    --default-font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    --default-font-family-mono: "Courier New", Courier, monospace;
  }

  .typography-f-s {
    font-family: var(--font-family, var(--default-font-family));
    font-optical-sizing: auto;
    font-variation-settings: "slnt" 0, "wdth" 100, "GRAD" 0;
  }

  .typography-f-sf {
    font-family: var(--font-family-flex, var(--default-font-family));
    font-optical-sizing: auto;
  }

  .typography-f-c {
    font-family: var(--font-family-mono, var(--default-font-family));
    font-optical-sizing: auto;
    font-variation-settings: "slnt" 0, "wdth" 100, "GRAD" 0;
  }

  .typography-v-r {
    font-variation-settings: "slnt" 0, "wdth" 100, "GRAD" 0, "ROND" 100;
  }

  .typography-ta-s {
    text-align: start;
  }

  .typography-ta-c {
    text-align: center;
  }

  .typography-fs-n {
    font-style: normal;
  }

  .typography-fs-i {
    font-style: italic;
  }

  .typography-sz-ls {
    font-size: 11px;
    line-height: 16px;
  }

  .typography-sz-lm {
    font-size: 12px;
    line-height: 16px;
  }

  .typography-sz-ll {
    font-size: 14px;
    line-height: 20px;
  }

  .typography-sz-bs {
    font-size: 12px;
    line-height: 16px;
  }

  .typography-sz-bm {
    font-size: 14px;
    line-height: 20px;
  }

  .typography-sz-bl {
    font-size: 16px;
    line-height: 24px;
  }

  .typography-sz-ts {
    font-size: 14px;
    line-height: 20px;
  }

  .typography-sz-tm {
    font-size: 16px;
    line-height: 24px;
  }

  .typography-sz-tl {
    font-size: 22px;
    line-height: 28px;
  }

  .typography-sz-hs {
    font-size: 24px;
    line-height: 32px;
  }

  .typography-sz-hm {
    font-size: 28px;
    line-height: 36px;
  }

  .typography-sz-hl {
    font-size: 32px;
    line-height: 40px;
  }

  .typography-sz-ds {
    font-size: 36px;
    line-height: 44px;
  }

  .typography-sz-dm {
    font-size: 45px;
    line-height: 52px;
  }

  .typography-sz-dl {
    font-size: 57px;
    line-height: 64px;
  }

  .typography-ws-p {
    white-space: pre-line;
  }

  .typography-ws-nw {
    white-space: nowrap;
  }

  .typography-td-none {
    text-decoration: none;
  }

  /** Weights **/

  ${new Array(9).fill(0).map((_, idx) => {
		const weight = (idx + 1) * 100;
		return `.typography-w-${weight} { font-weight: ${weight}; }`;
	}).join("\n")}
`
].flat(Infinity).join("\n");
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, {
	enumerable: true,
	configurable: true,
	writable: true,
	value
}) : obj[key] = value;
var __publicField = (obj, key, value) => {
	__defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
	return value;
};
var __accessCheck = (obj, member, msg) => {
	if (!member.has(obj)) throw TypeError("Cannot " + msg);
};
var __privateIn = (member, obj) => {
	if (Object(obj) !== obj) throw TypeError("Cannot use the \"in\" operator on this value");
	return member.has(obj);
};
var __privateAdd = (obj, member, value) => {
	if (member.has(obj)) throw TypeError("Cannot add the same private member more than once");
	member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
};
var __privateMethod = (obj, member, method) => {
	__accessCheck(obj, member, "access private method");
	return method;
};
/**
* @license
* Copyright Google LLC All Rights Reserved.
*
* Use of this source code is governed by an MIT-style license that can be
* found in the LICENSE file at https://angular.io/license
*/
function defaultEquals(a, b) {
	return Object.is(a, b);
}
/**
* @license
* Copyright Google LLC All Rights Reserved.
*
* Use of this source code is governed by an MIT-style license that can be
* found in the LICENSE file at https://angular.io/license
*/
let activeConsumer = null;
let inNotificationPhase = false;
let epoch = 1;
const SIGNAL = /* @__PURE__ */ Symbol("SIGNAL");
function setActiveConsumer(consumer) {
	const prev = activeConsumer;
	activeConsumer = consumer;
	return prev;
}
function getActiveConsumer() {
	return activeConsumer;
}
function isInNotificationPhase() {
	return inNotificationPhase;
}
const REACTIVE_NODE = {
	version: 0,
	lastCleanEpoch: 0,
	dirty: false,
	producerNode: void 0,
	producerLastReadVersion: void 0,
	producerIndexOfThis: void 0,
	nextProducerIndex: 0,
	liveConsumerNode: void 0,
	liveConsumerIndexOfThis: void 0,
	consumerAllowSignalWrites: false,
	consumerIsAlwaysLive: false,
	producerMustRecompute: () => false,
	producerRecomputeValue: () => {},
	consumerMarkedDirty: () => {},
	consumerOnSignalRead: () => {}
};
function producerAccessed(node) {
	if (inNotificationPhase) throw new Error(typeof ngDevMode !== "undefined" && ngDevMode ? `Assertion error: signal read during notification phase` : "");
	if (activeConsumer === null) return;
	activeConsumer.consumerOnSignalRead(node);
	const idx = activeConsumer.nextProducerIndex++;
	assertConsumerNode(activeConsumer);
	if (idx < activeConsumer.producerNode.length && activeConsumer.producerNode[idx] !== node) {
		if (consumerIsLive(activeConsumer)) {
			const staleProducer = activeConsumer.producerNode[idx];
			producerRemoveLiveConsumerAtIndex(staleProducer, activeConsumer.producerIndexOfThis[idx]);
		}
	}
	if (activeConsumer.producerNode[idx] !== node) {
		activeConsumer.producerNode[idx] = node;
		activeConsumer.producerIndexOfThis[idx] = consumerIsLive(activeConsumer) ? producerAddLiveConsumer(node, activeConsumer, idx) : 0;
	}
	activeConsumer.producerLastReadVersion[idx] = node.version;
}
function producerIncrementEpoch() {
	epoch++;
}
function producerUpdateValueVersion(node) {
	if (!node.dirty && node.lastCleanEpoch === epoch) return;
	if (!node.producerMustRecompute(node) && !consumerPollProducersForChange(node)) {
		node.dirty = false;
		node.lastCleanEpoch = epoch;
		return;
	}
	node.producerRecomputeValue(node);
	node.dirty = false;
	node.lastCleanEpoch = epoch;
}
function producerNotifyConsumers(node) {
	if (node.liveConsumerNode === void 0) return;
	const prev = inNotificationPhase;
	inNotificationPhase = true;
	try {
		for (const consumer of node.liveConsumerNode) if (!consumer.dirty) consumerMarkDirty(consumer);
	} finally {
		inNotificationPhase = prev;
	}
}
function producerUpdatesAllowed() {
	return (activeConsumer == null ? void 0 : activeConsumer.consumerAllowSignalWrites) !== false;
}
function consumerMarkDirty(node) {
	var _a;
	node.dirty = true;
	producerNotifyConsumers(node);
	(_a = node.consumerMarkedDirty) == null || _a.call(node.wrapper ?? node);
}
function consumerBeforeComputation(node) {
	node && (node.nextProducerIndex = 0);
	return setActiveConsumer(node);
}
function consumerAfterComputation(node, prevConsumer) {
	setActiveConsumer(prevConsumer);
	if (!node || node.producerNode === void 0 || node.producerIndexOfThis === void 0 || node.producerLastReadVersion === void 0) return;
	if (consumerIsLive(node)) for (let i = node.nextProducerIndex; i < node.producerNode.length; i++) producerRemoveLiveConsumerAtIndex(node.producerNode[i], node.producerIndexOfThis[i]);
	while (node.producerNode.length > node.nextProducerIndex) {
		node.producerNode.pop();
		node.producerLastReadVersion.pop();
		node.producerIndexOfThis.pop();
	}
}
function consumerPollProducersForChange(node) {
	assertConsumerNode(node);
	for (let i = 0; i < node.producerNode.length; i++) {
		const producer = node.producerNode[i];
		const seenVersion = node.producerLastReadVersion[i];
		if (seenVersion !== producer.version) return true;
		producerUpdateValueVersion(producer);
		if (seenVersion !== producer.version) return true;
	}
	return false;
}
function producerAddLiveConsumer(node, consumer, indexOfThis) {
	var _a;
	assertProducerNode(node);
	assertConsumerNode(node);
	if (node.liveConsumerNode.length === 0) {
		(_a = node.watched) == null || _a.call(node.wrapper);
		for (let i = 0; i < node.producerNode.length; i++) node.producerIndexOfThis[i] = producerAddLiveConsumer(node.producerNode[i], node, i);
	}
	node.liveConsumerIndexOfThis.push(indexOfThis);
	return node.liveConsumerNode.push(consumer) - 1;
}
function producerRemoveLiveConsumerAtIndex(node, idx) {
	var _a;
	assertProducerNode(node);
	assertConsumerNode(node);
	if (typeof ngDevMode !== "undefined" && ngDevMode && idx >= node.liveConsumerNode.length) throw new Error(`Assertion error: active consumer index ${idx} is out of bounds of ${node.liveConsumerNode.length} consumers)`);
	if (node.liveConsumerNode.length === 1) {
		(_a = node.unwatched) == null || _a.call(node.wrapper);
		for (let i = 0; i < node.producerNode.length; i++) producerRemoveLiveConsumerAtIndex(node.producerNode[i], node.producerIndexOfThis[i]);
	}
	const lastIdx = node.liveConsumerNode.length - 1;
	node.liveConsumerNode[idx] = node.liveConsumerNode[lastIdx];
	node.liveConsumerIndexOfThis[idx] = node.liveConsumerIndexOfThis[lastIdx];
	node.liveConsumerNode.length--;
	node.liveConsumerIndexOfThis.length--;
	if (idx < node.liveConsumerNode.length) {
		const idxProducer = node.liveConsumerIndexOfThis[idx];
		const consumer = node.liveConsumerNode[idx];
		assertConsumerNode(consumer);
		consumer.producerIndexOfThis[idxProducer] = idx;
	}
}
function consumerIsLive(node) {
	var _a;
	return node.consumerIsAlwaysLive || (((_a = node == null ? void 0 : node.liveConsumerNode) == null ? void 0 : _a.length) ?? 0) > 0;
}
function assertConsumerNode(node) {
	node.producerNode ?? (node.producerNode = []);
	node.producerIndexOfThis ?? (node.producerIndexOfThis = []);
	node.producerLastReadVersion ?? (node.producerLastReadVersion = []);
}
function assertProducerNode(node) {
	node.liveConsumerNode ?? (node.liveConsumerNode = []);
	node.liveConsumerIndexOfThis ?? (node.liveConsumerIndexOfThis = []);
}
/**
* @license
* Copyright Google LLC All Rights Reserved.
*
* Use of this source code is governed by an MIT-style license that can be
* found in the LICENSE file at https://angular.io/license
*/
function computedGet(node) {
	producerUpdateValueVersion(node);
	producerAccessed(node);
	if (node.value === ERRORED) throw node.error;
	return node.value;
}
function createComputed(computation) {
	const node = Object.create(COMPUTED_NODE);
	node.computation = computation;
	const computed = () => computedGet(node);
	computed[SIGNAL] = node;
	return computed;
}
const UNSET = /* @__PURE__ */ Symbol("UNSET");
const COMPUTING = /* @__PURE__ */ Symbol("COMPUTING");
const ERRORED = /* @__PURE__ */ Symbol("ERRORED");
const COMPUTED_NODE = /* @__PURE__ */ (() => {
	return {
		...REACTIVE_NODE,
		value: UNSET,
		dirty: true,
		error: null,
		equal: defaultEquals,
		producerMustRecompute(node) {
			return node.value === UNSET || node.value === COMPUTING;
		},
		producerRecomputeValue(node) {
			if (node.value === COMPUTING) throw new Error("Detected cycle in computations.");
			const oldValue = node.value;
			node.value = COMPUTING;
			const prevConsumer = consumerBeforeComputation(node);
			let newValue;
			let wasEqual = false;
			try {
				newValue = node.computation.call(node.wrapper);
				wasEqual = oldValue !== UNSET && oldValue !== ERRORED && node.equal.call(node.wrapper, oldValue, newValue);
			} catch (err) {
				newValue = ERRORED;
				node.error = err;
			} finally {
				consumerAfterComputation(node, prevConsumer);
			}
			if (wasEqual) {
				node.value = oldValue;
				return;
			}
			node.value = newValue;
			node.version++;
		}
	};
})();
/**
* @license
* Copyright Google LLC All Rights Reserved.
*
* Use of this source code is governed by an MIT-style license that can be
* found in the LICENSE file at https://angular.io/license
*/
function defaultThrowError() {
	throw new Error();
}
let throwInvalidWriteToSignalErrorFn = defaultThrowError;
function throwInvalidWriteToSignalError() {
	throwInvalidWriteToSignalErrorFn();
}
/**
* @license
* Copyright Google LLC All Rights Reserved.
*
* Use of this source code is governed by an MIT-style license that can be
* found in the LICENSE file at https://angular.io/license
*/
function createSignal(initialValue) {
	const node = Object.create(SIGNAL_NODE);
	node.value = initialValue;
	const getter = () => {
		producerAccessed(node);
		return node.value;
	};
	getter[SIGNAL] = node;
	return getter;
}
function signalGetFn() {
	producerAccessed(this);
	return this.value;
}
function signalSetFn(node, newValue) {
	if (!producerUpdatesAllowed()) throwInvalidWriteToSignalError();
	if (!node.equal.call(node.wrapper, node.value, newValue)) {
		node.value = newValue;
		signalValueChanged(node);
	}
}
const SIGNAL_NODE = /* @__PURE__ */ (() => {
	return {
		...REACTIVE_NODE,
		equal: defaultEquals,
		value: void 0
	};
})();
function signalValueChanged(node) {
	node.version++;
	producerIncrementEpoch();
	producerNotifyConsumers(node);
}
/**
* @license
* Copyright 2024 Bloomberg Finance L.P.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
const NODE = Symbol("node");
var Signal;
((Signal2) => {
	var _a, _brand, _b, _brand2;
	class State {
		constructor(initialValue, options = {}) {
			__privateAdd(this, _brand);
			__publicField(this, _a);
			const node = createSignal(initialValue)[SIGNAL];
			this[NODE] = node;
			node.wrapper = this;
			if (options) {
				const equals = options.equals;
				if (equals) node.equal = equals;
				node.watched = options[Signal2.subtle.watched];
				node.unwatched = options[Signal2.subtle.unwatched];
			}
		}
		get() {
			if (!(0, Signal2.isState)(this)) throw new TypeError("Wrong receiver type for Signal.State.prototype.get");
			return signalGetFn.call(this[NODE]);
		}
		set(newValue) {
			if (!(0, Signal2.isState)(this)) throw new TypeError("Wrong receiver type for Signal.State.prototype.set");
			if (isInNotificationPhase()) throw new Error("Writes to signals not permitted during Watcher callback");
			const ref = this[NODE];
			signalSetFn(ref, newValue);
		}
	}
	_a = NODE;
	_brand = /* @__PURE__ */ new WeakSet();
	Signal2.isState = (s) => typeof s === "object" && __privateIn(_brand, s);
	Signal2.State = State;
	class Computed {
		constructor(computation, options) {
			__privateAdd(this, _brand2);
			__publicField(this, _b);
			const node = createComputed(computation)[SIGNAL];
			node.consumerAllowSignalWrites = true;
			this[NODE] = node;
			node.wrapper = this;
			if (options) {
				const equals = options.equals;
				if (equals) node.equal = equals;
				node.watched = options[Signal2.subtle.watched];
				node.unwatched = options[Signal2.subtle.unwatched];
			}
		}
		get() {
			if (!(0, Signal2.isComputed)(this)) throw new TypeError("Wrong receiver type for Signal.Computed.prototype.get");
			return computedGet(this[NODE]);
		}
	}
	_b = NODE;
	_brand2 = /* @__PURE__ */ new WeakSet();
	Signal2.isComputed = (c) => typeof c === "object" && __privateIn(_brand2, c);
	Signal2.Computed = Computed;
	((subtle2) => {
		var _a2, _brand3, _assertSignals, assertSignals_fn;
		function untrack(cb) {
			let output;
			let prevActiveConsumer = null;
			try {
				prevActiveConsumer = setActiveConsumer(null);
				output = cb();
			} finally {
				setActiveConsumer(prevActiveConsumer);
			}
			return output;
		}
		subtle2.untrack = untrack;
		function introspectSources(sink) {
			var _a3;
			if (!(0, Signal2.isComputed)(sink) && !(0, Signal2.isWatcher)(sink)) throw new TypeError("Called introspectSources without a Computed or Watcher argument");
			return ((_a3 = sink[NODE].producerNode) == null ? void 0 : _a3.map((n) => n.wrapper)) ?? [];
		}
		subtle2.introspectSources = introspectSources;
		function introspectSinks(signal) {
			var _a3;
			if (!(0, Signal2.isComputed)(signal) && !(0, Signal2.isState)(signal)) throw new TypeError("Called introspectSinks without a Signal argument");
			return ((_a3 = signal[NODE].liveConsumerNode) == null ? void 0 : _a3.map((n) => n.wrapper)) ?? [];
		}
		subtle2.introspectSinks = introspectSinks;
		function hasSinks(signal) {
			if (!(0, Signal2.isComputed)(signal) && !(0, Signal2.isState)(signal)) throw new TypeError("Called hasSinks without a Signal argument");
			const liveConsumerNode = signal[NODE].liveConsumerNode;
			if (!liveConsumerNode) return false;
			return liveConsumerNode.length > 0;
		}
		subtle2.hasSinks = hasSinks;
		function hasSources(signal) {
			if (!(0, Signal2.isComputed)(signal) && !(0, Signal2.isWatcher)(signal)) throw new TypeError("Called hasSources without a Computed or Watcher argument");
			const producerNode = signal[NODE].producerNode;
			if (!producerNode) return false;
			return producerNode.length > 0;
		}
		subtle2.hasSources = hasSources;
		class Watcher {
			constructor(notify) {
				__privateAdd(this, _brand3);
				__privateAdd(this, _assertSignals);
				__publicField(this, _a2);
				let node = Object.create(REACTIVE_NODE);
				node.wrapper = this;
				node.consumerMarkedDirty = notify;
				node.consumerIsAlwaysLive = true;
				node.consumerAllowSignalWrites = false;
				node.producerNode = [];
				this[NODE] = node;
			}
			watch(...signals) {
				if (!(0, Signal2.isWatcher)(this)) throw new TypeError("Called unwatch without Watcher receiver");
				__privateMethod(this, _assertSignals, assertSignals_fn).call(this, signals);
				const node = this[NODE];
				node.dirty = false;
				const prev = setActiveConsumer(node);
				for (const signal of signals) producerAccessed(signal[NODE]);
				setActiveConsumer(prev);
			}
			unwatch(...signals) {
				if (!(0, Signal2.isWatcher)(this)) throw new TypeError("Called unwatch without Watcher receiver");
				__privateMethod(this, _assertSignals, assertSignals_fn).call(this, signals);
				const node = this[NODE];
				assertConsumerNode(node);
				for (let i = node.producerNode.length - 1; i >= 0; i--) if (signals.includes(node.producerNode[i].wrapper)) {
					producerRemoveLiveConsumerAtIndex(node.producerNode[i], node.producerIndexOfThis[i]);
					const lastIdx = node.producerNode.length - 1;
					node.producerNode[i] = node.producerNode[lastIdx];
					node.producerIndexOfThis[i] = node.producerIndexOfThis[lastIdx];
					node.producerNode.length--;
					node.producerIndexOfThis.length--;
					node.nextProducerIndex--;
					if (i < node.producerNode.length) {
						const idxConsumer = node.producerIndexOfThis[i];
						const producer = node.producerNode[i];
						assertProducerNode(producer);
						producer.liveConsumerIndexOfThis[idxConsumer] = i;
					}
				}
			}
			getPending() {
				if (!(0, Signal2.isWatcher)(this)) throw new TypeError("Called getPending without Watcher receiver");
				return this[NODE].producerNode.filter((n) => n.dirty).map((n) => n.wrapper);
			}
		}
		_a2 = NODE;
		_brand3 = /* @__PURE__ */ new WeakSet();
		_assertSignals = /* @__PURE__ */ new WeakSet();
		assertSignals_fn = function(signals) {
			for (const signal of signals) if (!(0, Signal2.isComputed)(signal) && !(0, Signal2.isState)(signal)) throw new TypeError("Called watch/unwatch without a Computed or State argument");
		};
		Signal2.isWatcher = (w) => __privateIn(_brand3, w);
		subtle2.Watcher = Watcher;
		function currentComputed() {
			var _a3;
			return (_a3 = getActiveConsumer()) == null ? void 0 : _a3.wrapper;
		}
		subtle2.currentComputed = currentComputed;
		subtle2.watched = Symbol("watched");
		subtle2.unwatched = Symbol("unwatched");
	})(Signal2.subtle || (Signal2.subtle = {}));
})(Signal || (Signal = {}));
/**
* equality check here is always false so that we can dirty the storage
* via setting to _anything_
*
*
* This is for a pattern where we don't *directly* use signals to back the values used in collections
* so that instanceof checks and getters and other native features "just work" without having
* to do nested proxying.
*
* (though, see deep.ts for nested / deep behavior)
*/
const createStorage = (initial = null) => new Signal.State(initial, { equals: () => false });
const ARRAY_GETTER_METHODS = new Set([
	Symbol.iterator,
	"concat",
	"entries",
	"every",
	"filter",
	"find",
	"findIndex",
	"flat",
	"flatMap",
	"forEach",
	"includes",
	"indexOf",
	"join",
	"keys",
	"lastIndexOf",
	"map",
	"reduce",
	"reduceRight",
	"slice",
	"some",
	"values"
]);
const ARRAY_WRITE_THEN_READ_METHODS = new Set([
	"fill",
	"push",
	"unshift"
]);
function convertToInt(prop) {
	if (typeof prop === "symbol") return null;
	const num = Number(prop);
	if (isNaN(num)) return null;
	return num % 1 === 0 ? num : null;
}
var SignalArray = class SignalArray {
	/**
	* Creates an array from an iterable object.
	* @param iterable An iterable object to convert to an array.
	*/
	/**
	* Creates an array from an iterable object.
	* @param iterable An iterable object to convert to an array.
	* @param mapfn A mapping function to call on every element of the array.
	* @param thisArg Value of 'this' used to invoke the mapfn.
	*/
	static from(iterable, mapfn, thisArg) {
		return mapfn ? new SignalArray(Array.from(iterable, mapfn, thisArg)) : new SignalArray(Array.from(iterable));
	}
	static of(...arr) {
		return new SignalArray(arr);
	}
	constructor(arr = []) {
		let clone = arr.slice();
		let self = this;
		let boundFns = /* @__PURE__ */ new Map();
		/**
		Flag to track whether we have *just* intercepted a call to `.push()` or
		`.unshift()`, since in those cases (and only those cases!) the `Array`
		itself checks `.length` to return from the function call.
		*/
		let nativelyAccessingLengthFromPushOrUnshift = false;
		return new Proxy(clone, {
			get(target, prop) {
				let index = convertToInt(prop);
				if (index !== null) {
					self.#readStorageFor(index);
					self.#collection.get();
					return target[index];
				}
				if (prop === "length") {
					if (nativelyAccessingLengthFromPushOrUnshift) nativelyAccessingLengthFromPushOrUnshift = false;
					else self.#collection.get();
					return target[prop];
				}
				if (ARRAY_WRITE_THEN_READ_METHODS.has(prop)) nativelyAccessingLengthFromPushOrUnshift = true;
				if (ARRAY_GETTER_METHODS.has(prop)) {
					let fn = boundFns.get(prop);
					if (fn === void 0) {
						fn = (...args) => {
							self.#collection.get();
							return target[prop](...args);
						};
						boundFns.set(prop, fn);
					}
					return fn;
				}
				return target[prop];
			},
			set(target, prop, value) {
				target[prop] = value;
				let index = convertToInt(prop);
				if (index !== null) {
					self.#dirtyStorageFor(index);
					self.#collection.set(null);
				} else if (prop === "length") self.#collection.set(null);
				return true;
			},
			getPrototypeOf() {
				return SignalArray.prototype;
			}
		});
	}
	#collection = createStorage();
	#storages = /* @__PURE__ */ new Map();
	#readStorageFor(index) {
		let storage = this.#storages.get(index);
		if (storage === void 0) {
			storage = createStorage();
			this.#storages.set(index, storage);
		}
		storage.get();
	}
	#dirtyStorageFor(index) {
		const storage = this.#storages.get(index);
		if (storage) storage.set(null);
	}
};
Object.setPrototypeOf(SignalArray.prototype, Array.prototype);
var SignalMap = class {
	collection = createStorage();
	storages = /* @__PURE__ */ new Map();
	vals;
	readStorageFor(key) {
		const { storages } = this;
		let storage = storages.get(key);
		if (storage === void 0) {
			storage = createStorage();
			storages.set(key, storage);
		}
		storage.get();
	}
	dirtyStorageFor(key) {
		const storage = this.storages.get(key);
		if (storage) storage.set(null);
	}
	constructor(existing) {
		this.vals = existing ? new Map(existing) : /* @__PURE__ */ new Map();
	}
	get(key) {
		this.readStorageFor(key);
		return this.vals.get(key);
	}
	has(key) {
		this.readStorageFor(key);
		return this.vals.has(key);
	}
	entries() {
		this.collection.get();
		return this.vals.entries();
	}
	keys() {
		this.collection.get();
		return this.vals.keys();
	}
	values() {
		this.collection.get();
		return this.vals.values();
	}
	forEach(fn) {
		this.collection.get();
		this.vals.forEach(fn);
	}
	get size() {
		this.collection.get();
		return this.vals.size;
	}
	[Symbol.iterator]() {
		this.collection.get();
		return this.vals[Symbol.iterator]();
	}
	get [Symbol.toStringTag]() {
		return this.vals[Symbol.toStringTag];
	}
	set(key, value) {
		this.dirtyStorageFor(key);
		this.collection.set(null);
		this.vals.set(key, value);
		return this;
	}
	delete(key) {
		this.dirtyStorageFor(key);
		this.collection.set(null);
		return this.vals.delete(key);
	}
	clear() {
		this.storages.forEach((s) => s.set(null));
		this.collection.set(null);
		this.vals.clear();
	}
};
Object.setPrototypeOf(SignalMap.prototype, Map.prototype);
/**
* Create a reactive Object, backed by Signals, using a Proxy.
* This allows dynamic creation and deletion of signals using the object primitive
* APIs that most folks are familiar with -- the only difference is instantiation.
* ```js
* const obj = new SignalObject({ foo: 123 });
*
* obj.foo // 123
* obj.foo = 456
* obj.foo // 456
* obj.bar = 2
* obj.bar // 2
* ```
*/
const SignalObject = class SignalObjectImpl {
	static fromEntries(entries) {
		return new SignalObjectImpl(Object.fromEntries(entries));
	}
	#storages = /* @__PURE__ */ new Map();
	#collection = createStorage();
	constructor(obj = {}) {
		let proto = Object.getPrototypeOf(obj);
		let descs = Object.getOwnPropertyDescriptors(obj);
		let clone = Object.create(proto);
		for (let prop in descs) Object.defineProperty(clone, prop, descs[prop]);
		let self = this;
		return new Proxy(clone, {
			get(target, prop, receiver) {
				self.#readStorageFor(prop);
				return Reflect.get(target, prop, receiver);
			},
			has(target, prop) {
				self.#readStorageFor(prop);
				return prop in target;
			},
			ownKeys(target) {
				self.#collection.get();
				return Reflect.ownKeys(target);
			},
			set(target, prop, value, receiver) {
				let result = Reflect.set(target, prop, value, receiver);
				self.#dirtyStorageFor(prop);
				self.#dirtyCollection();
				return result;
			},
			deleteProperty(target, prop) {
				if (prop in target) {
					delete target[prop];
					self.#dirtyStorageFor(prop);
					self.#dirtyCollection();
				}
				return true;
			},
			getPrototypeOf() {
				return SignalObjectImpl.prototype;
			}
		});
	}
	#readStorageFor(key) {
		let storage = this.#storages.get(key);
		if (storage === void 0) {
			storage = createStorage();
			this.#storages.set(key, storage);
		}
		storage.get();
	}
	#dirtyStorageFor(key) {
		const storage = this.#storages.get(key);
		if (storage) storage.set(null);
	}
	#dirtyCollection() {
		this.#collection.set(null);
	}
};
var SignalSet = class {
	collection = createStorage();
	storages = /* @__PURE__ */ new Map();
	vals;
	storageFor(key) {
		const storages = this.storages;
		let storage = storages.get(key);
		if (storage === void 0) {
			storage = createStorage();
			storages.set(key, storage);
		}
		return storage;
	}
	dirtyStorageFor(key) {
		const storage = this.storages.get(key);
		if (storage) storage.set(null);
	}
	constructor(existing) {
		this.vals = new Set(existing);
	}
	has(value) {
		this.storageFor(value).get();
		return this.vals.has(value);
	}
	entries() {
		this.collection.get();
		return this.vals.entries();
	}
	keys() {
		this.collection.get();
		return this.vals.keys();
	}
	values() {
		this.collection.get();
		return this.vals.values();
	}
	forEach(fn) {
		this.collection.get();
		this.vals.forEach(fn);
	}
	get size() {
		this.collection.get();
		return this.vals.size;
	}
	[Symbol.iterator]() {
		this.collection.get();
		return this.vals[Symbol.iterator]();
	}
	get [Symbol.toStringTag]() {
		return this.vals[Symbol.toStringTag];
	}
	add(value) {
		this.dirtyStorageFor(value);
		this.collection.set(null);
		this.vals.add(value);
		return this;
	}
	delete(value) {
		this.dirtyStorageFor(value);
		this.collection.set(null);
		return this.vals.delete(value);
	}
	clear() {
		this.storages.forEach((s) => s.set(null));
		this.collection.set(null);
		this.vals.clear();
	}
};
Object.setPrototypeOf(SignalSet.prototype, Set.prototype);
function create() {
	return new A2uiMessageProcessor({
		arrayCtor: SignalArray,
		mapCtor: SignalMap,
		objCtor: SignalObject,
		setCtor: SignalSet
	});
}
const Data = {
	createSignalA2uiMessageProcessor: create,
	A2uiMessageProcessor,
	Guards: guards_exports
};
/**
* @license
* Copyright 2019 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
const t$7 = globalThis, e$13 = t$7.ShadowRoot && (void 0 === t$7.ShadyCSS || t$7.ShadyCSS.nativeShadow) && "adoptedStyleSheets" in Document.prototype && "replace" in CSSStyleSheet.prototype, s$9 = Symbol(), o$14 = /* @__PURE__ */ new WeakMap();
var n$13 = class {
	constructor(t, e, o) {
		if (this._$cssResult$ = !0, o !== s$9) throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");
		this.cssText = t, this.t = e;
	}
	get styleSheet() {
		let t = this.o;
		const s = this.t;
		if (e$13 && void 0 === t) {
			const e = void 0 !== s && 1 === s.length;
			e && (t = o$14.get(s)), void 0 === t && ((this.o = t = new CSSStyleSheet()).replaceSync(this.cssText), e && o$14.set(s, t));
		}
		return t;
	}
	toString() {
		return this.cssText;
	}
};
const r$11 = (t) => new n$13("string" == typeof t ? t : t + "", void 0, s$9), i$10 = (t, ...e) => {
	return new n$13(1 === t.length ? t[0] : e.reduce((e, s, o) => e + ((t) => {
		if (!0 === t._$cssResult$) return t.cssText;
		if ("number" == typeof t) return t;
		throw Error("Value passed to 'css' function must be a 'css' function result: " + t + ". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.");
	})(s) + t[o + 1], t[0]), t, s$9);
}, S$1 = (s, o) => {
	if (e$13) s.adoptedStyleSheets = o.map((t) => t instanceof CSSStyleSheet ? t : t.styleSheet);
	else for (const e of o) {
		const o = document.createElement("style"), n = t$7.litNonce;
		void 0 !== n && o.setAttribute("nonce", n), o.textContent = e.cssText, s.appendChild(o);
	}
}, c$7 = e$13 ? (t) => t : (t) => t instanceof CSSStyleSheet ? ((t) => {
	let e = "";
	for (const s of t.cssRules) e += s.cssText;
	return r$11(e);
})(t) : t;
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ const { is: i$9, defineProperty: e$12, getOwnPropertyDescriptor: h$7, getOwnPropertyNames: r$10, getOwnPropertySymbols: o$13, getPrototypeOf: n$12 } = Object, a$1 = globalThis, c$6 = a$1.trustedTypes, l$4 = c$6 ? c$6.emptyScript : "", p$2 = a$1.reactiveElementPolyfillSupport, d$2 = (t, s) => t, u$3 = {
	toAttribute(t, s) {
		switch (s) {
			case Boolean:
				t = t ? l$4 : null;
				break;
			case Object:
			case Array: t = null == t ? t : JSON.stringify(t);
		}
		return t;
	},
	fromAttribute(t, s) {
		let i = t;
		switch (s) {
			case Boolean:
				i = null !== t;
				break;
			case Number:
				i = null === t ? null : Number(t);
				break;
			case Object:
			case Array: try {
				i = JSON.parse(t);
			} catch (t) {
				i = null;
			}
		}
		return i;
	}
}, f$3 = (t, s) => !i$9(t, s), b$1 = {
	attribute: !0,
	type: String,
	converter: u$3,
	reflect: !1,
	useDefault: !1,
	hasChanged: f$3
};
Symbol.metadata ??= Symbol("metadata"), a$1.litPropertyMetadata ??= /* @__PURE__ */ new WeakMap();
var y$1 = class extends HTMLElement {
	static addInitializer(t) {
		this._$Ei(), (this.l ??= []).push(t);
	}
	static get observedAttributes() {
		return this.finalize(), this._$Eh && [...this._$Eh.keys()];
	}
	static createProperty(t, s = b$1) {
		if (s.state && (s.attribute = !1), this._$Ei(), this.prototype.hasOwnProperty(t) && ((s = Object.create(s)).wrapped = !0), this.elementProperties.set(t, s), !s.noAccessor) {
			const i = Symbol(), h = this.getPropertyDescriptor(t, i, s);
			void 0 !== h && e$12(this.prototype, t, h);
		}
	}
	static getPropertyDescriptor(t, s, i) {
		const { get: e, set: r } = h$7(this.prototype, t) ?? {
			get() {
				return this[s];
			},
			set(t) {
				this[s] = t;
			}
		};
		return {
			get: e,
			set(s) {
				const h = e?.call(this);
				r?.call(this, s), this.requestUpdate(t, h, i);
			},
			configurable: !0,
			enumerable: !0
		};
	}
	static getPropertyOptions(t) {
		return this.elementProperties.get(t) ?? b$1;
	}
	static _$Ei() {
		if (this.hasOwnProperty(d$2("elementProperties"))) return;
		const t = n$12(this);
		t.finalize(), void 0 !== t.l && (this.l = [...t.l]), this.elementProperties = new Map(t.elementProperties);
	}
	static finalize() {
		if (this.hasOwnProperty(d$2("finalized"))) return;
		if (this.finalized = !0, this._$Ei(), this.hasOwnProperty(d$2("properties"))) {
			const t = this.properties, s = [...r$10(t), ...o$13(t)];
			for (const i of s) this.createProperty(i, t[i]);
		}
		const t = this[Symbol.metadata];
		if (null !== t) {
			const s = litPropertyMetadata.get(t);
			if (void 0 !== s) for (const [t, i] of s) this.elementProperties.set(t, i);
		}
		this._$Eh = /* @__PURE__ */ new Map();
		for (const [t, s] of this.elementProperties) {
			const i = this._$Eu(t, s);
			void 0 !== i && this._$Eh.set(i, t);
		}
		this.elementStyles = this.finalizeStyles(this.styles);
	}
	static finalizeStyles(s) {
		const i = [];
		if (Array.isArray(s)) {
			const e = new Set(s.flat(Infinity).reverse());
			for (const s of e) i.unshift(c$7(s));
		} else void 0 !== s && i.push(c$7(s));
		return i;
	}
	static _$Eu(t, s) {
		const i = s.attribute;
		return !1 === i ? void 0 : "string" == typeof i ? i : "string" == typeof t ? t.toLowerCase() : void 0;
	}
	constructor() {
		super(), this._$Ep = void 0, this.isUpdatePending = !1, this.hasUpdated = !1, this._$Em = null, this._$Ev();
	}
	_$Ev() {
		this._$ES = new Promise((t) => this.enableUpdating = t), this._$AL = /* @__PURE__ */ new Map(), this._$E_(), this.requestUpdate(), this.constructor.l?.forEach((t) => t(this));
	}
	addController(t) {
		(this._$EO ??= /* @__PURE__ */ new Set()).add(t), void 0 !== this.renderRoot && this.isConnected && t.hostConnected?.();
	}
	removeController(t) {
		this._$EO?.delete(t);
	}
	_$E_() {
		const t = /* @__PURE__ */ new Map(), s = this.constructor.elementProperties;
		for (const i of s.keys()) this.hasOwnProperty(i) && (t.set(i, this[i]), delete this[i]);
		t.size > 0 && (this._$Ep = t);
	}
	createRenderRoot() {
		const t = this.shadowRoot ?? this.attachShadow(this.constructor.shadowRootOptions);
		return S$1(t, this.constructor.elementStyles), t;
	}
	connectedCallback() {
		this.renderRoot ??= this.createRenderRoot(), this.enableUpdating(!0), this._$EO?.forEach((t) => t.hostConnected?.());
	}
	enableUpdating(t) {}
	disconnectedCallback() {
		this._$EO?.forEach((t) => t.hostDisconnected?.());
	}
	attributeChangedCallback(t, s, i) {
		this._$AK(t, i);
	}
	_$ET(t, s) {
		const i = this.constructor.elementProperties.get(t), e = this.constructor._$Eu(t, i);
		if (void 0 !== e && !0 === i.reflect) {
			const h = (void 0 !== i.converter?.toAttribute ? i.converter : u$3).toAttribute(s, i.type);
			this._$Em = t, null == h ? this.removeAttribute(e) : this.setAttribute(e, h), this._$Em = null;
		}
	}
	_$AK(t, s) {
		const i = this.constructor, e = i._$Eh.get(t);
		if (void 0 !== e && this._$Em !== e) {
			const t = i.getPropertyOptions(e), h = "function" == typeof t.converter ? { fromAttribute: t.converter } : void 0 !== t.converter?.fromAttribute ? t.converter : u$3;
			this._$Em = e;
			const r = h.fromAttribute(s, t.type);
			this[e] = r ?? this._$Ej?.get(e) ?? r, this._$Em = null;
		}
	}
	requestUpdate(t, s, i, e = !1, h) {
		if (void 0 !== t) {
			const r = this.constructor;
			if (!1 === e && (h = this[t]), i ??= r.getPropertyOptions(t), !((i.hasChanged ?? f$3)(h, s) || i.useDefault && i.reflect && h === this._$Ej?.get(t) && !this.hasAttribute(r._$Eu(t, i)))) return;
			this.C(t, s, i);
		}
		!1 === this.isUpdatePending && (this._$ES = this._$EP());
	}
	C(t, s, { useDefault: i, reflect: e, wrapped: h }, r) {
		i && !(this._$Ej ??= /* @__PURE__ */ new Map()).has(t) && (this._$Ej.set(t, r ?? s ?? this[t]), !0 !== h || void 0 !== r) || (this._$AL.has(t) || (this.hasUpdated || i || (s = void 0), this._$AL.set(t, s)), !0 === e && this._$Em !== t && (this._$Eq ??= /* @__PURE__ */ new Set()).add(t));
	}
	async _$EP() {
		this.isUpdatePending = !0;
		try {
			await this._$ES;
		} catch (t) {
			Promise.reject(t);
		}
		const t = this.scheduleUpdate();
		return null != t && await t, !this.isUpdatePending;
	}
	scheduleUpdate() {
		return this.performUpdate();
	}
	performUpdate() {
		if (!this.isUpdatePending) return;
		if (!this.hasUpdated) {
			if (this.renderRoot ??= this.createRenderRoot(), this._$Ep) {
				for (const [t, s] of this._$Ep) this[t] = s;
				this._$Ep = void 0;
			}
			const t = this.constructor.elementProperties;
			if (t.size > 0) for (const [s, i] of t) {
				const { wrapped: t } = i, e = this[s];
				!0 !== t || this._$AL.has(s) || void 0 === e || this.C(s, void 0, i, e);
			}
		}
		let t = !1;
		const s = this._$AL;
		try {
			t = this.shouldUpdate(s), t ? (this.willUpdate(s), this._$EO?.forEach((t) => t.hostUpdate?.()), this.update(s)) : this._$EM();
		} catch (s) {
			throw t = !1, this._$EM(), s;
		}
		t && this._$AE(s);
	}
	willUpdate(t) {}
	_$AE(t) {
		this._$EO?.forEach((t) => t.hostUpdated?.()), this.hasUpdated || (this.hasUpdated = !0, this.firstUpdated(t)), this.updated(t);
	}
	_$EM() {
		this._$AL = /* @__PURE__ */ new Map(), this.isUpdatePending = !1;
	}
	get updateComplete() {
		return this.getUpdateComplete();
	}
	getUpdateComplete() {
		return this._$ES;
	}
	shouldUpdate(t) {
		return !0;
	}
	update(t) {
		this._$Eq &&= this._$Eq.forEach((t) => this._$ET(t, this[t])), this._$EM();
	}
	updated(t) {}
	firstUpdated(t) {}
};
y$1.elementStyles = [], y$1.shadowRootOptions = { mode: "open" }, y$1[d$2("elementProperties")] = /* @__PURE__ */ new Map(), y$1[d$2("finalized")] = /* @__PURE__ */ new Map(), p$2?.({ ReactiveElement: y$1 }), (a$1.reactiveElementVersions ??= []).push("2.1.2");
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
const t$6 = globalThis, i$8 = (t) => t, s$8 = t$6.trustedTypes, e$11 = s$8 ? s$8.createPolicy("lit-html", { createHTML: (t) => t }) : void 0, h$6 = "$lit$", o$12 = `lit$${Math.random().toFixed(9).slice(2)}$`, n$11 = "?" + o$12, r$9 = `<${n$11}>`, l$3 = document, c$5 = () => l$3.createComment(""), a = (t) => null === t || "object" != typeof t && "function" != typeof t, u$2 = Array.isArray, d$1 = (t) => u$2(t) || "function" == typeof t?.[Symbol.iterator], f$2 = "[ 	\n\f\r]", v$1 = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g, _ = /-->/g, m$3 = />/g, p$1 = RegExp(`>|${f$2}(?:([^\\s"'>=/]+)(${f$2}*=${f$2}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`, "g"), g = /'/g, $ = /"/g, y = /^(?:script|style|textarea|title)$/i, x = (t) => (i, ...s) => ({
	_$litType$: t,
	strings: i,
	values: s
}), b = x(1), E = Symbol.for("lit-noChange"), A = Symbol.for("lit-nothing"), C = /* @__PURE__ */ new WeakMap(), P = l$3.createTreeWalker(l$3, 129);
function V(t, i) {
	if (!u$2(t) || !t.hasOwnProperty("raw")) throw Error("invalid template strings array");
	return void 0 !== e$11 ? e$11.createHTML(i) : i;
}
const N = (t, i) => {
	const s = t.length - 1, e = [];
	let n, l = 2 === i ? "<svg>" : 3 === i ? "<math>" : "", c = v$1;
	for (let i = 0; i < s; i++) {
		const s = t[i];
		let a, u, d = -1, f = 0;
		for (; f < s.length && (c.lastIndex = f, u = c.exec(s), null !== u);) f = c.lastIndex, c === v$1 ? "!--" === u[1] ? c = _ : void 0 !== u[1] ? c = m$3 : void 0 !== u[2] ? (y.test(u[2]) && (n = RegExp("</" + u[2], "g")), c = p$1) : void 0 !== u[3] && (c = p$1) : c === p$1 ? ">" === u[0] ? (c = n ?? v$1, d = -1) : void 0 === u[1] ? d = -2 : (d = c.lastIndex - u[2].length, a = u[1], c = void 0 === u[3] ? p$1 : "\"" === u[3] ? $ : g) : c === $ || c === g ? c = p$1 : c === _ || c === m$3 ? c = v$1 : (c = p$1, n = void 0);
		const x = c === p$1 && t[i + 1].startsWith("/>") ? " " : "";
		l += c === v$1 ? s + r$9 : d >= 0 ? (e.push(a), s.slice(0, d) + h$6 + s.slice(d) + o$12 + x) : s + o$12 + (-2 === d ? i : x);
	}
	return [V(t, l + (t[s] || "<?>") + (2 === i ? "</svg>" : 3 === i ? "</math>" : "")), e];
};
var S = class S {
	constructor({ strings: t, _$litType$: i }, e) {
		let r;
		this.parts = [];
		let l = 0, a = 0;
		const u = t.length - 1, d = this.parts, [f, v] = N(t, i);
		if (this.el = S.createElement(f, e), P.currentNode = this.el.content, 2 === i || 3 === i) {
			const t = this.el.content.firstChild;
			t.replaceWith(...t.childNodes);
		}
		for (; null !== (r = P.nextNode()) && d.length < u;) {
			if (1 === r.nodeType) {
				if (r.hasAttributes()) for (const t of r.getAttributeNames()) if (t.endsWith(h$6)) {
					const i = v[a++], s = r.getAttribute(t).split(o$12), e = /([.?@])?(.*)/.exec(i);
					d.push({
						type: 1,
						index: l,
						name: e[2],
						strings: s,
						ctor: "." === e[1] ? I : "?" === e[1] ? L : "@" === e[1] ? z : H
					}), r.removeAttribute(t);
				} else t.startsWith(o$12) && (d.push({
					type: 6,
					index: l
				}), r.removeAttribute(t));
				if (y.test(r.tagName)) {
					const t = r.textContent.split(o$12), i = t.length - 1;
					if (i > 0) {
						r.textContent = s$8 ? s$8.emptyScript : "";
						for (let s = 0; s < i; s++) r.append(t[s], c$5()), P.nextNode(), d.push({
							type: 2,
							index: ++l
						});
						r.append(t[i], c$5());
					}
				}
			} else if (8 === r.nodeType) if (r.data === n$11) d.push({
				type: 2,
				index: l
			});
			else {
				let t = -1;
				for (; -1 !== (t = r.data.indexOf(o$12, t + 1));) d.push({
					type: 7,
					index: l
				}), t += o$12.length - 1;
			}
			l++;
		}
	}
	static createElement(t, i) {
		const s = l$3.createElement("template");
		return s.innerHTML = t, s;
	}
};
function M$1(t, i, s = t, e) {
	if (i === E) return i;
	let h = void 0 !== e ? s._$Co?.[e] : s._$Cl;
	const o = a(i) ? void 0 : i._$litDirective$;
	return h?.constructor !== o && (h?._$AO?.(!1), void 0 === o ? h = void 0 : (h = new o(t), h._$AT(t, s, e)), void 0 !== e ? (s._$Co ??= [])[e] = h : s._$Cl = h), void 0 !== h && (i = M$1(t, h._$AS(t, i.values), h, e)), i;
}
var R = class {
	constructor(t, i) {
		this._$AV = [], this._$AN = void 0, this._$AD = t, this._$AM = i;
	}
	get parentNode() {
		return this._$AM.parentNode;
	}
	get _$AU() {
		return this._$AM._$AU;
	}
	u(t) {
		const { el: { content: i }, parts: s } = this._$AD, e = (t?.creationScope ?? l$3).importNode(i, !0);
		P.currentNode = e;
		let h = P.nextNode(), o = 0, n = 0, r = s[0];
		for (; void 0 !== r;) {
			if (o === r.index) {
				let i;
				2 === r.type ? i = new k(h, h.nextSibling, this, t) : 1 === r.type ? i = new r.ctor(h, r.name, r.strings, this, t) : 6 === r.type && (i = new Z(h, this, t)), this._$AV.push(i), r = s[++n];
			}
			o !== r?.index && (h = P.nextNode(), o++);
		}
		return P.currentNode = l$3, e;
	}
	p(t) {
		let i = 0;
		for (const s of this._$AV) void 0 !== s && (void 0 !== s.strings ? (s._$AI(t, s, i), i += s.strings.length - 2) : s._$AI(t[i])), i++;
	}
};
var k = class k {
	get _$AU() {
		return this._$AM?._$AU ?? this._$Cv;
	}
	constructor(t, i, s, e) {
		this.type = 2, this._$AH = A, this._$AN = void 0, this._$AA = t, this._$AB = i, this._$AM = s, this.options = e, this._$Cv = e?.isConnected ?? !0;
	}
	get parentNode() {
		let t = this._$AA.parentNode;
		const i = this._$AM;
		return void 0 !== i && 11 === t?.nodeType && (t = i.parentNode), t;
	}
	get startNode() {
		return this._$AA;
	}
	get endNode() {
		return this._$AB;
	}
	_$AI(t, i = this) {
		t = M$1(this, t, i), a(t) ? t === A || null == t || "" === t ? (this._$AH !== A && this._$AR(), this._$AH = A) : t !== this._$AH && t !== E && this._(t) : void 0 !== t._$litType$ ? this.$(t) : void 0 !== t.nodeType ? this.T(t) : d$1(t) ? this.k(t) : this._(t);
	}
	O(t) {
		return this._$AA.parentNode.insertBefore(t, this._$AB);
	}
	T(t) {
		this._$AH !== t && (this._$AR(), this._$AH = this.O(t));
	}
	_(t) {
		this._$AH !== A && a(this._$AH) ? this._$AA.nextSibling.data = t : this.T(l$3.createTextNode(t)), this._$AH = t;
	}
	$(t) {
		const { values: i, _$litType$: s } = t, e = "number" == typeof s ? this._$AC(t) : (void 0 === s.el && (s.el = S.createElement(V(s.h, s.h[0]), this.options)), s);
		if (this._$AH?._$AD === e) this._$AH.p(i);
		else {
			const t = new R(e, this), s = t.u(this.options);
			t.p(i), this.T(s), this._$AH = t;
		}
	}
	_$AC(t) {
		let i = C.get(t.strings);
		return void 0 === i && C.set(t.strings, i = new S(t)), i;
	}
	k(t) {
		u$2(this._$AH) || (this._$AH = [], this._$AR());
		const i = this._$AH;
		let s, e = 0;
		for (const h of t) e === i.length ? i.push(s = new k(this.O(c$5()), this.O(c$5()), this, this.options)) : s = i[e], s._$AI(h), e++;
		e < i.length && (this._$AR(s && s._$AB.nextSibling, e), i.length = e);
	}
	_$AR(t = this._$AA.nextSibling, s) {
		for (this._$AP?.(!1, !0, s); t !== this._$AB;) {
			const s = i$8(t).nextSibling;
			i$8(t).remove(), t = s;
		}
	}
	setConnected(t) {
		void 0 === this._$AM && (this._$Cv = t, this._$AP?.(t));
	}
};
var H = class {
	get tagName() {
		return this.element.tagName;
	}
	get _$AU() {
		return this._$AM._$AU;
	}
	constructor(t, i, s, e, h) {
		this.type = 1, this._$AH = A, this._$AN = void 0, this.element = t, this.name = i, this._$AM = e, this.options = h, s.length > 2 || "" !== s[0] || "" !== s[1] ? (this._$AH = Array(s.length - 1).fill(/* @__PURE__ */ new String()), this.strings = s) : this._$AH = A;
	}
	_$AI(t, i = this, s, e) {
		const h = this.strings;
		let o = !1;
		if (void 0 === h) t = M$1(this, t, i, 0), o = !a(t) || t !== this._$AH && t !== E, o && (this._$AH = t);
		else {
			const e = t;
			let n, r;
			for (t = h[0], n = 0; n < h.length - 1; n++) r = M$1(this, e[s + n], i, n), r === E && (r = this._$AH[n]), o ||= !a(r) || r !== this._$AH[n], r === A ? t = A : t !== A && (t += (r ?? "") + h[n + 1]), this._$AH[n] = r;
		}
		o && !e && this.j(t);
	}
	j(t) {
		t === A ? this.element.removeAttribute(this.name) : this.element.setAttribute(this.name, t ?? "");
	}
};
var I = class extends H {
	constructor() {
		super(...arguments), this.type = 3;
	}
	j(t) {
		this.element[this.name] = t === A ? void 0 : t;
	}
};
var L = class extends H {
	constructor() {
		super(...arguments), this.type = 4;
	}
	j(t) {
		this.element.toggleAttribute(this.name, !!t && t !== A);
	}
};
var z = class extends H {
	constructor(t, i, s, e, h) {
		super(t, i, s, e, h), this.type = 5;
	}
	_$AI(t, i = this) {
		if ((t = M$1(this, t, i, 0) ?? A) === E) return;
		const s = this._$AH, e = t === A && s !== A || t.capture !== s.capture || t.once !== s.once || t.passive !== s.passive, h = t !== A && (s === A || e);
		e && this.element.removeEventListener(this.name, this, s), h && this.element.addEventListener(this.name, this, t), this._$AH = t;
	}
	handleEvent(t) {
		"function" == typeof this._$AH ? this._$AH.call(this.options?.host ?? this.element, t) : this._$AH.handleEvent(t);
	}
};
var Z = class {
	constructor(t, i, s) {
		this.element = t, this.type = 6, this._$AN = void 0, this._$AM = i, this.options = s;
	}
	get _$AU() {
		return this._$AM._$AU;
	}
	_$AI(t) {
		M$1(this, t);
	}
};
const j$1 = {
	M: h$6,
	P: o$12,
	A: n$11,
	C: 1,
	L: N,
	R,
	D: d$1,
	V: M$1,
	I: k,
	H,
	N: L,
	U: z,
	B: I,
	F: Z
}, B = t$6.litHtmlPolyfillSupport;
B?.(S, k), (t$6.litHtmlVersions ??= []).push("3.3.3");
const D = (t, i, s) => {
	const e = s?.renderBefore ?? i;
	let h = e._$litPart$;
	if (void 0 === h) {
		const t = s?.renderBefore ?? null;
		e._$litPart$ = h = new k(i.insertBefore(c$5(), t), t, void 0, s ?? {});
	}
	return h._$AI(t), h;
};
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ const s$7 = globalThis;
var i$7 = class extends y$1 {
	constructor() {
		super(...arguments), this.renderOptions = { host: this }, this._$Do = void 0;
	}
	createRenderRoot() {
		const t = super.createRenderRoot();
		return this.renderOptions.renderBefore ??= t.firstChild, t;
	}
	update(t) {
		const r = this.render();
		this.hasUpdated || (this.renderOptions.isConnected = this.isConnected), super.update(t), this._$Do = D(r, this.renderRoot, this.renderOptions);
	}
	connectedCallback() {
		super.connectedCallback(), this._$Do?.setConnected(!0);
	}
	disconnectedCallback() {
		super.disconnectedCallback(), this._$Do?.setConnected(!1);
	}
	render() {
		return E;
	}
};
i$7._$litElement$ = !0, i$7["finalized"] = !0, s$7.litElementHydrateSupport?.({ LitElement: i$7 });
const o$11 = s$7.litElementPolyfillSupport;
o$11?.({ LitElement: i$7 });
(s$7.litElementVersions ??= []).push("4.2.2");
/**
* @license
* Copyright 2022 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
const t$5 = (t) => (e, o) => {
	void 0 !== o ? o.addInitializer(() => {
		customElements.define(t, e);
	}) : customElements.define(t, e);
};
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ const o$9 = {
	attribute: !0,
	type: String,
	converter: u$3,
	reflect: !1,
	hasChanged: f$3
}, r$8 = (t = o$9, e, r) => {
	const { kind: n, metadata: i } = r;
	let s = globalThis.litPropertyMetadata.get(i);
	if (void 0 === s && globalThis.litPropertyMetadata.set(i, s = /* @__PURE__ */ new Map()), "setter" === n && ((t = Object.create(t)).wrapped = !0), s.set(r.name, t), "accessor" === n) {
		const { name: o } = r;
		return {
			set(r) {
				const n = e.get.call(this);
				e.set.call(this, r), this.requestUpdate(o, n, t, !0, r);
			},
			init(e) {
				return void 0 !== e && this.C(o, void 0, t, e), e;
			}
		};
	}
	if ("setter" === n) {
		const { name: o } = r;
		return function(r) {
			const n = this[o];
			e.call(this, r), this.requestUpdate(o, n, t, !0, r);
		};
	}
	throw Error("Unsupported decorator location: " + n);
};
function n$9(t) {
	return (e, o) => "object" == typeof o ? r$8(t, e, o) : ((t, e, o) => {
		const r = e.hasOwnProperty(o);
		return e.constructor.createProperty(o, t), r ? Object.getOwnPropertyDescriptor(e, o) : void 0;
	})(t, e, o);
}
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ function r$7(r) {
	return n$9({
		...r,
		state: !0,
		attribute: !1
	});
}
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
const e$10 = (e, t, c) => (c.configurable = !0, c.enumerable = !0, Reflect.decorate && "object" != typeof t && Object.defineProperty(e, t, c), c);
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ function e$9(e, r) {
	return (n, s, i) => {
		const o = (t) => t.renderRoot?.querySelector(e) ?? null;
		if (r) {
			const { get: e, set: r } = "object" == typeof s ? n : i ?? (() => {
				const t = Symbol();
				return {
					get() {
						return this[t];
					},
					set(e) {
						this[t] = e;
					}
				};
			})();
			return e$10(n, s, { get() {
				let t = e.call(this);
				return void 0 === t && (t = o(this), (null !== t || this.hasUpdated) && r.call(this, t)), t;
			} });
		}
		return e$10(n, s, { get() {
			return o(this);
		} });
	};
}
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
/**
* @license
* Copyright 2023 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ let i$6 = !1;
const s$6 = new Signal.subtle.Watcher(() => {
	i$6 || (i$6 = !0, queueMicrotask(() => {
		i$6 = !1;
		for (const t of s$6.getPending()) t.get();
		s$6.watch();
	}));
}), h$5 = Symbol("SignalWatcherBrand"), e$7 = new FinalizationRegistry((i) => {
	i.unwatch(...Signal.subtle.introspectSources(i));
}), n$7 = /* @__PURE__ */ new WeakMap();
function o$7(i) {
	return !0 === i[h$5] ? (console.warn("SignalWatcher should not be applied to the same class more than once."), i) : class extends i {
		constructor() {
			super(...arguments), this._$St = /* @__PURE__ */ new Map(), this._$So = new Signal.State(0), this._$Si = !1;
		}
		_$Sl() {
			var t, i;
			const s = [], h = [];
			this._$St.forEach((t, i) => {
				((null == t ? void 0 : t.beforeUpdate) ? s : h).push(i);
			});
			const e = null === (t = this.h) || void 0 === t ? void 0 : t.getPending().filter((t) => t !== this._$Su && !this._$St.has(t));
			s.forEach((t) => t.get()), null === (i = this._$Su) || void 0 === i || i.get(), e.forEach((t) => t.get()), h.forEach((t) => t.get());
		}
		_$Sv() {
			this.isUpdatePending || queueMicrotask(() => {
				this.isUpdatePending || this._$Sl();
			});
		}
		_$S_() {
			if (void 0 !== this.h) return;
			this._$Su = new Signal.Computed(() => {
				this._$So.get(), super.performUpdate();
			});
			const i = this.h = new Signal.subtle.Watcher(function() {
				const t = n$7.get(this);
				void 0 !== t && (!1 === t._$Si && (new Set(this.getPending()).has(t._$Su) ? t.requestUpdate() : t._$Sv()), this.watch());
			});
			n$7.set(i, this), e$7.register(this, i), i.watch(this._$Su), i.watch(...Array.from(this._$St).map(([t]) => t));
		}
		_$Sp() {
			if (void 0 === this.h) return;
			let i = !1;
			this.h.unwatch(...Signal.subtle.introspectSources(this.h).filter((t) => {
				var s;
				const h = !0 !== (null === (s = this._$St.get(t)) || void 0 === s ? void 0 : s.manualDispose);
				return h && this._$St.delete(t), i || (i = !h), h;
			})), i || (this._$Su = void 0, this.h = void 0, this._$St.clear());
		}
		updateEffect(i, s) {
			var h;
			this._$S_();
			const e = new Signal.Computed(() => {
				i();
			});
			return this.h.watch(e), this._$St.set(e, s), null !== (h = null == s ? void 0 : s.beforeUpdate) && void 0 !== h && h ? Signal.subtle.untrack(() => e.get()) : this.updateComplete.then(() => Signal.subtle.untrack(() => e.get())), () => {
				this._$St.delete(e), this.h.unwatch(e), !1 === this.isConnected && this._$Sp();
			};
		}
		performUpdate() {
			this.isUpdatePending && (this._$S_(), this._$Si = !0, this._$So.set(this._$So.get() + 1), this._$Si = !1, this._$Sl());
		}
		connectedCallback() {
			super.connectedCallback(), this.requestUpdate();
		}
		disconnectedCallback() {
			super.disconnectedCallback(), queueMicrotask(() => {
				!1 === this.isConnected && this._$Sp();
			});
		}
	};
}
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
const t$3 = {
	ATTRIBUTE: 1,
	CHILD: 2,
	PROPERTY: 3,
	BOOLEAN_ATTRIBUTE: 4,
	EVENT: 5,
	ELEMENT: 6
}, e$6 = (t) => (...e) => ({
	_$litDirective$: t,
	values: e
});
var i$5 = class {
	constructor(t) {}
	get _$AU() {
		return this._$AM._$AU;
	}
	_$AT(t, e, i) {
		this._$Ct = t, this._$AM = e, this._$Ci = i;
	}
	_$AS(t, e) {
		return this.update(t, e);
	}
	update(t, e) {
		return this.render(...e);
	}
};
/**
* @license
* Copyright 2020 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ const { I: t$2 } = j$1, i$4 = (o) => o, n$6 = (o) => null === o || "object" != typeof o && "function" != typeof o, r$4 = (o) => void 0 === o.strings, s$5 = () => document.createComment(""), v = (o, n, e) => {
	const l = o._$AA.parentNode, d = void 0 === n ? o._$AB : n._$AA;
	if (void 0 === e) e = new t$2(l.insertBefore(s$5(), d), l.insertBefore(s$5(), d), o, o.options);
	else {
		const t = e._$AB.nextSibling, n = e._$AM, c = n !== o;
		if (c) {
			let t;
			e._$AQ?.(o), e._$AM = o, void 0 !== e._$AP && (t = o._$AU) !== n._$AU && e._$AP(t);
		}
		if (t !== d || c) {
			let o = e._$AA;
			for (; o !== t;) {
				const t = i$4(o).nextSibling;
				i$4(l).insertBefore(o, d), o = t;
			}
		}
	}
	return e;
}, u$1 = (o, t, i = o) => (o._$AI(t, i), o), m$2 = {}, p = (o, t = m$2) => o._$AH = t, M = (o) => o._$AH, h$4 = (o) => {
	o._$AR(), o._$AA.remove();
};
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ const s$4 = (i, t) => {
	const e = i._$AN;
	if (void 0 === e) return !1;
	for (const i of e) i._$AO?.(t, !1), s$4(i, t);
	return !0;
}, o$6 = (i) => {
	let t, e;
	do {
		if (void 0 === (t = i._$AM)) break;
		e = t._$AN, e.delete(i), i = t;
	} while (0 === e?.size);
}, r$3 = (i) => {
	for (let t; t = i._$AM; i = t) {
		let e = t._$AN;
		if (void 0 === e) t._$AN = e = /* @__PURE__ */ new Set();
		else if (e.has(i)) break;
		e.add(i), c$3(t);
	}
};
function h$3(i) {
	void 0 !== this._$AN ? (o$6(this), this._$AM = i, r$3(this)) : this._$AM = i;
}
function n$5(i, t = !1, e = 0) {
	const r = this._$AH, h = this._$AN;
	if (void 0 !== h && 0 !== h.size) if (t) if (Array.isArray(r)) for (let i = e; i < r.length; i++) s$4(r[i], !1), o$6(r[i]);
	else null != r && (s$4(r, !1), o$6(r));
	else s$4(this, i);
}
const c$3 = (i) => {
	i.type == t$3.CHILD && (i._$AP ??= n$5, i._$AQ ??= h$3);
};
var f = class extends i$5 {
	constructor() {
		super(...arguments), this._$AN = void 0;
	}
	_$AT(i, t, e) {
		super._$AT(i, t, e), r$3(this), this.isConnected = i._$AU;
	}
	_$AO(i, t = !0) {
		i !== this.isConnected && (this.isConnected = i, i ? this.reconnected?.() : this.disconnected?.()), t && (s$4(this, i), o$6(this));
	}
	setValue(t) {
		if (r$4(this._$Ct)) this._$Ct._$AI(t, this);
		else {
			const i = [...this._$Ct._$AH];
			i[this._$Ci] = t, this._$Ct._$AI(i, this, 0);
		}
	}
	disconnected() {}
	reconnected() {}
};
/**
* @license
* Copyright 2023 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
let o$5 = !1;
const n$4 = new Signal.subtle.Watcher(async () => {
	o$5 || (o$5 = !0, queueMicrotask(() => {
		o$5 = !1;
		for (const i of n$4.getPending()) i.get();
		n$4.watch();
	}));
});
/**
* @license
* Copyright 2023 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
/**
* @license
* Copyright 2023 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
Signal.State;
Signal.Computed;
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
var s$3 = class extends Event {
	constructor(s, t, e, o) {
		super("context-request", {
			bubbles: !0,
			composed: !0
		}), this.context = s, this.contextTarget = t, this.callback = e, this.subscribe = o ?? !1;
	}
};
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
function n$3(n) {
	return n;
}
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ var s$2 = class {
	constructor(t, s, i, h) {
		if (this.subscribe = !1, this.provided = !1, this.value = void 0, this.t = (t, s) => {
			this.unsubscribe && (this.unsubscribe !== s && (this.provided = !1, this.unsubscribe()), this.subscribe || this.unsubscribe()), this.value = t, this.host.requestUpdate(), this.provided && !this.subscribe || (this.provided = !0, this.callback && this.callback(t, s)), this.unsubscribe = s;
		}, this.host = t, void 0 !== s.context) {
			const t = s;
			this.context = t.context, this.callback = t.callback, this.subscribe = t.subscribe ?? !1;
		} else this.context = s, this.callback = i, this.subscribe = h ?? !1;
		this.host.addController(this);
	}
	hostConnected() {
		this.dispatchRequest();
	}
	hostDisconnected() {
		this.unsubscribe && (this.unsubscribe(), this.unsubscribe = void 0);
	}
	dispatchRequest() {
		this.host.dispatchEvent(new s$3(this.context, this.host, this.t, this.subscribe));
	}
};
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
var s$1 = class {
	get value() {
		return this.o;
	}
	set value(s) {
		this.setValue(s);
	}
	setValue(s, t = !1) {
		const i = t || !Object.is(s, this.o);
		this.o = s, i && this.updateObservers();
	}
	constructor(s) {
		this.subscriptions = /* @__PURE__ */ new Map(), this.updateObservers = () => {
			for (const [s, { disposer: t }] of this.subscriptions) s(this.o, t);
		}, void 0 !== s && (this.value = s);
	}
	addCallback(s, t, i) {
		if (!i) return void s(this.value);
		this.subscriptions.has(s) || this.subscriptions.set(s, {
			disposer: () => {
				this.subscriptions.delete(s);
			},
			consumerHost: t
		});
		const { disposer: h } = this.subscriptions.get(s);
		s(this.value, h);
	}
	clearCallbacks() {
		this.subscriptions.clear();
	}
};
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ var e$4 = class extends Event {
	constructor(t, s) {
		super("context-provider", {
			bubbles: !0,
			composed: !0
		}), this.context = t, this.contextTarget = s;
	}
};
var i$2 = class extends s$1 {
	constructor(s, e, i) {
		super(void 0 !== e.context ? e.initialValue : i), this.onContextRequest = (t) => {
			if (t.context !== this.context) return;
			const s = t.contextTarget ?? t.composedPath()[0];
			s !== this.host && (t.stopPropagation(), this.addCallback(t.callback, s, t.subscribe));
		}, this.onProviderRequest = (s) => {
			if (s.context !== this.context) return;
			if ((s.contextTarget ?? s.composedPath()[0]) === this.host) return;
			const e = /* @__PURE__ */ new Set();
			for (const [s, { consumerHost: i }] of this.subscriptions) e.has(s) || (e.add(s), i.dispatchEvent(new s$3(this.context, i, s, !0)));
			s.stopPropagation();
		}, this.host = s, void 0 !== e.context ? this.context = e.context : this.context = e, this.attachListeners(), this.host.addController?.(this);
	}
	attachListeners() {
		this.host.addEventListener("context-request", this.onContextRequest), this.host.addEventListener("context-provider", this.onProviderRequest);
	}
	hostConnected() {
		this.host.dispatchEvent(new e$4(this.context, this.host));
	}
};
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
/**
* @license
* Copyright 2022 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ function c$2({ context: c, subscribe: e }) {
	return (o, n) => {
		"object" == typeof n ? n.addInitializer((function() {
			new s$2(this, {
				context: c,
				callback: (t) => {
					o.set.call(this, t);
				},
				subscribe: e
			});
		})) : o.constructor.addInitializer(((o) => {
			new s$2(o, {
				context: c,
				callback: (t) => {
					o[n] = t;
				},
				subscribe: e
			});
		}));
	};
}
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
function* o$3(o, f) {
	if (void 0 !== o) {
		let i = 0;
		for (const t of o) yield f(t, i++);
	}
}
let pending = false;
let watcher = new Signal.subtle.Watcher(() => {
	if (!pending) {
		pending = true;
		queueMicrotask(() => {
			pending = false;
			flushPending();
		});
	}
});
function flushPending() {
	for (const signal of watcher.getPending()) signal.get();
	watcher.watch();
}
/**
* ⚠️ WARNING: Nothing unwatches ⚠️
* This will produce a memory leak.
*/
function effect(cb) {
	let c = new Signal.Computed(() => cb());
	watcher.watch(c);
	c.get();
	return () => {
		watcher.unwatch(c);
	};
}
/**
* An alias for the theme context, for backwards-compatibility.
*
* @deprecated Use `theme` instead.
*/
const themeContext = n$3(Symbol("A2UITheme"));
const buildStructuralStyles = () => {
	if (typeof window === "undefined") return [];
	try {
		const styleSheet = new CSSStyleSheet();
		styleSheet.replaceSync(structuralStyles$1);
		return styleSheet;
	} catch (e) {
		throw new Error("Failed to construct structural styles.", { cause: e });
	}
};
const structuralStyles = buildStructuralStyles();
var ComponentRegistry = class {
	constructor() {
		this.schemas = /* @__PURE__ */ new Map();
		this.registry = /* @__PURE__ */ new Map();
	}
	register(typeName, constructor, tagName, schema) {
		if (!/^[a-zA-Z0-9]+$/.test(typeName)) throw new Error(`[Registry] Invalid typeName '${typeName}'. Must be alphanumeric.`);
		this.registry.set(typeName, constructor);
		if (schema) this.schemas.set(typeName, schema);
		const actualTagName = tagName || `a2ui-custom-${typeName.toLowerCase()}`;
		const existingName = customElements.getName(constructor);
		if (existingName) {
			if (existingName !== actualTagName) throw new Error(`Component ${typeName} is already registered as ${existingName}, but requested as ${actualTagName}.`);
			return;
		}
		if (!customElements.get(actualTagName)) customElements.define(actualTagName, constructor);
	}
	get(typeName) {
		return this.registry.get(typeName);
	}
	getInlineCatalog() {
		const components = {};
		for (const [key, value] of this.schemas) components[key] = value;
		return { components };
	}
};
const componentRegistry = new ComponentRegistry();
var __runInitializers$19 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate$19 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
let Root = (() => {
	let _classDecorators = [t$5("a2ui-root")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = o$7(i$7);
	let _instanceExtraInitializers = [];
	let _surfaceId_decorators;
	let _surfaceId_initializers = [];
	let _surfaceId_extraInitializers = [];
	let _component_decorators;
	let _component_initializers = [];
	let _component_extraInitializers = [];
	let _theme_decorators;
	let _theme_initializers = [];
	let _theme_extraInitializers = [];
	let _childComponents_decorators;
	let _childComponents_initializers = [];
	let _childComponents_extraInitializers = [];
	let _processor_decorators;
	let _processor_initializers = [];
	let _processor_extraInitializers = [];
	let _dataContextPath_decorators;
	let _dataContextPath_initializers = [];
	let _dataContextPath_extraInitializers = [];
	let _enableCustomElements_decorators;
	let _enableCustomElements_initializers = [];
	let _enableCustomElements_extraInitializers = [];
	let _set_weight_decorators;
	var Root = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_surfaceId_decorators = [n$9()];
			_component_decorators = [n$9()];
			_theme_decorators = [c$2({ context: themeContext })];
			_childComponents_decorators = [n$9({ attribute: false })];
			_processor_decorators = [n$9({ attribute: false })];
			_dataContextPath_decorators = [n$9()];
			_enableCustomElements_decorators = [n$9()];
			_set_weight_decorators = [n$9()];
			__esDecorate$19(this, null, _surfaceId_decorators, {
				kind: "accessor",
				name: "surfaceId",
				static: false,
				private: false,
				access: {
					has: (obj) => "surfaceId" in obj,
					get: (obj) => obj.surfaceId,
					set: (obj, value) => {
						obj.surfaceId = value;
					}
				},
				metadata: _metadata
			}, _surfaceId_initializers, _surfaceId_extraInitializers);
			__esDecorate$19(this, null, _component_decorators, {
				kind: "accessor",
				name: "component",
				static: false,
				private: false,
				access: {
					has: (obj) => "component" in obj,
					get: (obj) => obj.component,
					set: (obj, value) => {
						obj.component = value;
					}
				},
				metadata: _metadata
			}, _component_initializers, _component_extraInitializers);
			__esDecorate$19(this, null, _theme_decorators, {
				kind: "accessor",
				name: "theme",
				static: false,
				private: false,
				access: {
					has: (obj) => "theme" in obj,
					get: (obj) => obj.theme,
					set: (obj, value) => {
						obj.theme = value;
					}
				},
				metadata: _metadata
			}, _theme_initializers, _theme_extraInitializers);
			__esDecorate$19(this, null, _childComponents_decorators, {
				kind: "accessor",
				name: "childComponents",
				static: false,
				private: false,
				access: {
					has: (obj) => "childComponents" in obj,
					get: (obj) => obj.childComponents,
					set: (obj, value) => {
						obj.childComponents = value;
					}
				},
				metadata: _metadata
			}, _childComponents_initializers, _childComponents_extraInitializers);
			__esDecorate$19(this, null, _processor_decorators, {
				kind: "accessor",
				name: "processor",
				static: false,
				private: false,
				access: {
					has: (obj) => "processor" in obj,
					get: (obj) => obj.processor,
					set: (obj, value) => {
						obj.processor = value;
					}
				},
				metadata: _metadata
			}, _processor_initializers, _processor_extraInitializers);
			__esDecorate$19(this, null, _dataContextPath_decorators, {
				kind: "accessor",
				name: "dataContextPath",
				static: false,
				private: false,
				access: {
					has: (obj) => "dataContextPath" in obj,
					get: (obj) => obj.dataContextPath,
					set: (obj, value) => {
						obj.dataContextPath = value;
					}
				},
				metadata: _metadata
			}, _dataContextPath_initializers, _dataContextPath_extraInitializers);
			__esDecorate$19(this, null, _enableCustomElements_decorators, {
				kind: "accessor",
				name: "enableCustomElements",
				static: false,
				private: false,
				access: {
					has: (obj) => "enableCustomElements" in obj,
					get: (obj) => obj.enableCustomElements,
					set: (obj, value) => {
						obj.enableCustomElements = value;
					}
				},
				metadata: _metadata
			}, _enableCustomElements_initializers, _enableCustomElements_extraInitializers);
			__esDecorate$19(this, null, _set_weight_decorators, {
				kind: "setter",
				name: "weight",
				static: false,
				private: false,
				access: {
					has: (obj) => "weight" in obj,
					set: (obj, value) => {
						obj.weight = value;
					}
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate$19(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Root = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#surfaceId_accessor_storage = (__runInitializers$19(this, _instanceExtraInitializers), __runInitializers$19(this, _surfaceId_initializers, null));
		get surfaceId() {
			return this.#surfaceId_accessor_storage;
		}
		set surfaceId(value) {
			this.#surfaceId_accessor_storage = value;
		}
		#component_accessor_storage = (__runInitializers$19(this, _surfaceId_extraInitializers), __runInitializers$19(this, _component_initializers, null));
		get component() {
			return this.#component_accessor_storage;
		}
		set component(value) {
			this.#component_accessor_storage = value;
		}
		#theme_accessor_storage = (__runInitializers$19(this, _component_extraInitializers), __runInitializers$19(this, _theme_initializers, void 0));
		get theme() {
			return this.#theme_accessor_storage;
		}
		set theme(value) {
			this.#theme_accessor_storage = value;
		}
		#childComponents_accessor_storage = (__runInitializers$19(this, _theme_extraInitializers), __runInitializers$19(this, _childComponents_initializers, null));
		get childComponents() {
			return this.#childComponents_accessor_storage;
		}
		set childComponents(value) {
			this.#childComponents_accessor_storage = value;
		}
		#processor_accessor_storage = (__runInitializers$19(this, _childComponents_extraInitializers), __runInitializers$19(this, _processor_initializers, null));
		get processor() {
			return this.#processor_accessor_storage;
		}
		set processor(value) {
			this.#processor_accessor_storage = value;
		}
		#dataContextPath_accessor_storage = (__runInitializers$19(this, _processor_extraInitializers), __runInitializers$19(this, _dataContextPath_initializers, ""));
		get dataContextPath() {
			return this.#dataContextPath_accessor_storage;
		}
		set dataContextPath(value) {
			this.#dataContextPath_accessor_storage = value;
		}
		#enableCustomElements_accessor_storage = (__runInitializers$19(this, _dataContextPath_extraInitializers), __runInitializers$19(this, _enableCustomElements_initializers, false));
		get enableCustomElements() {
			return this.#enableCustomElements_accessor_storage;
		}
		set enableCustomElements(value) {
			this.#enableCustomElements_accessor_storage = value;
		}
		set weight(weight) {
			this.#weight = weight;
			this.style.setProperty("--weight", `${weight}`);
		}
		get weight() {
			return this.#weight;
		}
		#weight = (__runInitializers$19(this, _enableCustomElements_extraInitializers), 1);
		static {
			this.styles = [structuralStyles, i$10`
      :host {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 80%;
      }
    `];
		}
		/**
		* Holds the cleanup function for our effect.
		* We need this to stop the effect when the component is disconnected.
		*/
		#lightDomEffectDisposer = null;
		willUpdate(changedProperties) {
			if (changedProperties.has("childComponents")) {
				if (this.#lightDomEffectDisposer) this.#lightDomEffectDisposer();
				this.#lightDomEffectDisposer = effect(() => {
					const allChildren = this.childComponents ?? null;
					D(this.renderComponentTree(allChildren), this, { host: this });
				});
			}
		}
		/**
		* Clean up the effect when the component is removed from the DOM.
		*/
		disconnectedCallback() {
			super.disconnectedCallback();
			if (this.#lightDomEffectDisposer) this.#lightDomEffectDisposer();
		}
		/**
		* Turns the SignalMap into a renderable TemplateResult for Lit.
		*/
		renderComponentTree(components) {
			if (!components) return A;
			if (!Array.isArray(components)) return A;
			return b` ${o$3(components, (component) => {
				if (this.enableCustomElements) {
					const elCtor = componentRegistry.get(component.type) || customElements.get(component.type);
					if (elCtor) {
						const node = component;
						const el = new elCtor();
						el.id = node.id;
						if (node.slotName) el.slot = node.slotName;
						el.component = node;
						el.weight = node.weight ?? "initial";
						el.processor = this.processor;
						el.surfaceId = this.surfaceId;
						el.dataContextPath = node.dataContextPath ?? "/";
						for (const [prop, val] of Object.entries(component.properties)) el[prop] = val;
						return b`${el}`;
					}
				}
				switch (component.type) {
					case "List": {
						const node = component;
						const childComponents = node.properties.children;
						return b`<a2ui-list
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .direction=${node.properties.direction ?? "vertical"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .childComponents=${childComponents}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-list>`;
					}
					case "Card": {
						const node = component;
						let childComponents = node.properties.children;
						if (!childComponents && node.properties.child) childComponents = [node.properties.child];
						return b`<a2ui-card
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .childComponents=${childComponents}
            .dataContextPath=${node.dataContextPath ?? ""}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-card>`;
					}
					case "Column": {
						const node = component;
						return b`<a2ui-column
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .childComponents=${node.properties.children ?? null}
            .dataContextPath=${node.dataContextPath ?? ""}
            .alignment=${node.properties.alignment ?? "stretch"}
            .distribution=${node.properties.distribution ?? "start"}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-column>`;
					}
					case "Row": {
						const node = component;
						return b`<a2ui-row
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .childComponents=${node.properties.children ?? null}
            .dataContextPath=${node.dataContextPath ?? ""}
            .alignment=${node.properties.alignment ?? "stretch"}
            .distribution=${node.properties.distribution ?? "start"}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-row>`;
					}
					case "Image": {
						const node = component;
						return b`<a2ui-image
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .url=${node.properties.url ?? null}
            .dataContextPath=${node.dataContextPath ?? ""}
            .usageHint=${node.properties.usageHint}
            .fit=${node.properties.fit}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-image>`;
					}
					case "Icon": {
						const node = component;
						return b`<a2ui-icon
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .name=${node.properties.name ?? null}
            .dataContextPath=${node.dataContextPath ?? ""}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-icon>`;
					}
					case "AudioPlayer": {
						const node = component;
						return b`<a2ui-audioplayer
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .url=${node.properties.url ?? null}
            .dataContextPath=${node.dataContextPath ?? ""}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-audioplayer>`;
					}
					case "Button": {
						const node = component;
						return b`<a2ui-button
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath ?? ""}
            .action=${node.properties.action}
            .childComponents=${[node.properties.child]}
            .primary=${node.properties.primary}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-button>`;
					}
					case "Text": {
						const node = component;
						return b`<a2ui-text
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .model=${this.processor}
            .surfaceId=${this.surfaceId}
            .processor=${this.processor}
            .dataContextPath=${node.dataContextPath}
            .text=${node.properties.text}
            .usageHint=${node.properties.usageHint}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-text>`;
					}
					case "CheckBox": {
						const node = component;
						return b`<a2ui-checkbox
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath ?? ""}
            .label=${node.properties.label}
            .value=${node.properties.value}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-checkbox>`;
					}
					case "DateTimeInput": {
						const node = component;
						return b`<a2ui-datetimeinput
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath ?? ""}
            .enableDate=${node.properties.enableDate ?? true}
            .enableTime=${node.properties.enableTime ?? true}
            .value=${node.properties.value}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-datetimeinput>`;
					}
					case "Divider": {
						const node = component;
						return b`<a2ui-divider
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .thickness=${node.properties.thickness}
            .axis=${node.properties.axis}
            .color=${node.properties.color}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-divider>`;
					}
					case "MultipleChoice": {
						const node = component;
						return b`<a2ui-multiplechoice
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .options=${node.properties.options}
            .maxAllowedSelections=${node.properties.maxAllowedSelections}
            .selections=${node.properties.selections}
            .variant=${node.properties.variant}
            .filterable=${node.properties.filterable}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-multiplechoice>`;
					}
					case "Slider": {
						const node = component;
						return b`<a2ui-slider
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .value=${node.properties.value}
            .minValue=${node.properties.minValue}
            .maxValue=${node.properties.maxValue}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-slider>`;
					}
					case "TextField": {
						const node = component;
						return b`<a2ui-textfield
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .label=${node.properties.label}
            .text=${node.properties.text}
            .textFieldType=${node.properties.textFieldType}
            .validationRegexp=${node.properties.validationRegexp}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-textfield>`;
					}
					case "Video": {
						const node = component;
						return b`<a2ui-video
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .url=${node.properties.url}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-video>`;
					}
					case "Tabs": {
						const node = component;
						const titles = [];
						const childComponents = [];
						if (node.properties.tabItems) for (const item of node.properties.tabItems) {
							titles.push(item.title);
							childComponents.push(item.child);
						}
						return b`<a2ui-tabs
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .titles=${titles}
            .childComponents=${childComponents}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-tabs>`;
					}
					case "Modal": {
						const node = component;
						const childComponents = [node.properties.entryPointChild, node.properties.contentChild];
						node.properties.entryPointChild.slotName = "entry";
						return b`<a2ui-modal
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .childComponents=${childComponents}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-modal>`;
					}
					default: return this.renderCustomComponent(component);
				}
			})}`;
		}
		renderCustomComponent(component) {
			if (!this.enableCustomElements) return;
			const node = component;
			const elCtor = componentRegistry.get(component.type) || customElements.get(component.type);
			if (!elCtor) return b`Unknown element ${component.type}`;
			const el = new elCtor();
			el.id = node.id;
			if (node.slotName) el.slot = node.slotName;
			el.component = node;
			el.weight = node.weight ?? "initial";
			el.processor = this.processor;
			el.surfaceId = this.surfaceId;
			el.dataContextPath = node.dataContextPath ?? "/";
			for (const [prop, val] of Object.entries(component.properties)) el[prop] = val;
			return b`${el}`;
		}
		render() {
			return b`<slot></slot>`;
		}
		static {
			__runInitializers$19(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
/**
* @license
* Copyright 2018 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ const e$2 = e$6(class extends i$5 {
	constructor(t) {
		if (super(t), t.type !== t$3.ATTRIBUTE || "class" !== t.name || t.strings?.length > 2) throw Error("`classMap()` can only be used in the `class` attribute and must be the only part in the attribute.");
	}
	render(t) {
		return " " + Object.keys(t).filter((s) => t[s]).join(" ") + " ";
	}
	update(s, [i]) {
		if (void 0 === this.st) {
			this.st = /* @__PURE__ */ new Set(), void 0 !== s.strings && (this.nt = new Set(s.strings.join(" ").split(/\s/).filter((t) => "" !== t)));
			for (const t in i) i[t] && !this.nt?.has(t) && this.st.add(t);
			return this.render(i);
		}
		const r = s.element.classList;
		for (const t of this.st) t in i || (r.remove(t), this.st.delete(t));
		for (const t in i) {
			const s = !!i[t];
			s === this.st.has(t) || this.nt?.has(t) || (s ? (r.add(t), this.st.add(t)) : (r.remove(t), this.st.delete(t)));
		}
		return E;
	}
});
/**
* @license
* Copyright 2018 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ const n$2 = "important", i$1 = " !important", o$2 = e$6(class extends i$5 {
	constructor(t) {
		if (super(t), t.type !== t$3.ATTRIBUTE || "style" !== t.name || t.strings?.length > 2) throw Error("The `styleMap` directive must be used in the `style` attribute and must be the only part in the attribute.");
	}
	render(t) {
		return Object.keys(t).reduce((e, r) => {
			const s = t[r];
			return null == s ? e : e + `${r = r.includes("-") ? r : r.replace(/(?:^(webkit|moz|ms|o)|)(?=[A-Z])/g, "-$&").toLowerCase()}:${s};`;
		}, "");
	}
	update(e, [r]) {
		const { style: s } = e.element;
		if (void 0 === this.ft) return this.ft = new Set(Object.keys(r)), this.render(r);
		for (const t of this.ft) null == r[t] && (this.ft.delete(t), t.includes("-") ? s.removeProperty(t) : s[t] = null);
		for (const t in r) {
			const e = r[t];
			if (null != e) {
				this.ft.add(t);
				const r = "string" == typeof e && e.endsWith(i$1);
				t.includes("-") || r ? s.setProperty(t, r ? e.slice(0, -11) : e, r ? n$2 : "") : s[t] = e;
			}
		}
		return E;
	}
});
var __esDecorate$18 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$18 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-audioplayer")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _url_decorators;
	let _url_initializers = [];
	let _url_extraInitializers = [];
	var Audio = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_url_decorators = [n$9()];
			__esDecorate$18(this, null, _url_decorators, {
				kind: "accessor",
				name: "url",
				static: false,
				private: false,
				access: {
					has: (obj) => "url" in obj,
					get: (obj) => obj.url,
					set: (obj, value) => {
						obj.url = value;
					}
				},
				metadata: _metadata
			}, _url_initializers, _url_extraInitializers);
			__esDecorate$18(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Audio = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#url_accessor_storage = __runInitializers$18(this, _url_initializers, null);
		get url() {
			return this.#url_accessor_storage;
		}
		set url(value) {
			this.#url_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$10`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      audio {
        display: block;
        width: 100%;
      }
    `];
		}
		#renderAudio() {
			if (!this.url) return A;
			if (this.url && typeof this.url === "object") {
				if ("literalString" in this.url) return b`<audio controls src=${this.url.literalString} />`;
				else if ("literal" in this.url) return b`<audio controls src=${this.url.literal} />`;
				else if (this.url && "path" in this.url && this.url.path) {
					if (!this.processor || !this.component) return b`(no processor)`;
					const audioUrl = this.processor.getData(this.component, this.url.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (!audioUrl) return b`Invalid audio URL`;
					if (typeof audioUrl !== "string") return b`Invalid audio URL`;
					return b`<audio controls src=${audioUrl} />`;
				}
			}
			return b`(empty)`;
		}
		render() {
			return b`<section
      class=${e$2(this.theme.components.AudioPlayer)}
      style=${this.theme.additionalStyles?.AudioPlayer ? o$2(this.theme.additionalStyles?.AudioPlayer) : A}
    >
      ${this.#renderAudio()}
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$18(this, _url_extraInitializers);
		}
		static {
			__runInitializers$18(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$17 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$17 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-button")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _action_decorators;
	let _action_initializers = [];
	let _action_extraInitializers = [];
	let _primary_decorators;
	let _primary_initializers = [];
	let _primary_extraInitializers = [];
	var Button = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_action_decorators = [n$9()];
			_primary_decorators = [n$9()];
			__esDecorate$17(this, null, _action_decorators, {
				kind: "accessor",
				name: "action",
				static: false,
				private: false,
				access: {
					has: (obj) => "action" in obj,
					get: (obj) => obj.action,
					set: (obj, value) => {
						obj.action = value;
					}
				},
				metadata: _metadata
			}, _action_initializers, _action_extraInitializers);
			__esDecorate$17(this, null, _primary_decorators, {
				kind: "accessor",
				name: "primary",
				static: false,
				private: false,
				access: {
					has: (obj) => "primary" in obj,
					get: (obj) => obj.primary,
					set: (obj, value) => {
						obj.primary = value;
					}
				},
				metadata: _metadata
			}, _primary_initializers, _primary_extraInitializers);
			__esDecorate$17(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Button = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#action_accessor_storage = __runInitializers$17(this, _action_initializers, null);
		get action() {
			return this.#action_accessor_storage;
		}
		set action(value) {
			this.#action_accessor_storage = value;
		}
		#primary_accessor_storage = (__runInitializers$17(this, _action_extraInitializers), __runInitializers$17(this, _primary_initializers, false));
		get primary() {
			return this.#primary_accessor_storage;
		}
		set primary(value) {
			this.#primary_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$10`
      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
      }
    `];
		}
		render() {
			return b`<button
      class=${e$2(this.theme.components.Button)}
      style=${this.theme.additionalStyles?.Button ? o$2(this.theme.additionalStyles?.Button) : A}
      @click=${() => {
				if (!this.action) return;
				const evt = new StateEvent({
					eventType: "a2ui.action",
					action: this.action,
					dataContextPath: this.dataContextPath,
					sourceComponentId: this.id,
					sourceComponent: this.component
				});
				this.dispatchEvent(evt);
			}}
    >
      <slot></slot>
    </button>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$17(this, _primary_extraInitializers);
		}
		static {
			__runInitializers$17(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$16 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$16 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-card")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	var Card = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			__esDecorate$16(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Card = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static {
			this.styles = [structuralStyles, i$10`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      section {
        height: 100%;
        width: 100%;
        min-height: 0;
        overflow: auto;

        ::slotted(*) {
          height: 100%;
          width: 100%;
        }
      }
    `];
		}
		render() {
			return b` <section
      class=${e$2(this.theme.components.Card)}
      style=${this.theme.additionalStyles?.Card ? o$2(this.theme.additionalStyles?.Card) : A}
    >
      <slot></slot>
    </section>`;
		}
		static {
			__runInitializers$16(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
function extractStringValue(val, component, processor, surfaceId) {
	if (val !== null && typeof val === "object") {
		if ("literalString" in val) return val.literalString ?? "";
		else if ("literal" in val && val.literal !== void 0) return val.literal ?? "";
		else if (val && "path" in val && val.path) {
			if (!processor || !component) return "(no model)";
			const textValue = processor.getData(component, val.path, surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
			if (textValue === null || typeof textValue !== "string") return "";
			return textValue;
		}
	}
	return "";
}
function extractNumberValue(val, component, processor, surfaceId) {
	if (val !== null && typeof val === "object") {
		if ("literalNumber" in val) return val.literalNumber ?? 0;
		else if ("literal" in val && val.literal !== void 0) return val.literal ?? 0;
		else if (val && "path" in val && val.path) {
			if (!processor || !component) return -1;
			let numberValue = processor.getData(component, val.path, surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
			if (typeof numberValue === "string") {
				numberValue = Number.parseInt(numberValue, 10);
				if (Number.isNaN(numberValue)) numberValue = null;
			}
			if (numberValue === null || typeof numberValue !== "number") return -1;
			return numberValue;
		}
	}
	return 0;
}
var __esDecorate$15 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$15 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-checkbox")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _value_decorators;
	let _value_initializers = [];
	let _value_extraInitializers = [];
	let _label_decorators;
	let _label_initializers = [];
	let _label_extraInitializers = [];
	var Checkbox = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_value_decorators = [n$9()];
			_label_decorators = [n$9()];
			__esDecorate$15(this, null, _value_decorators, {
				kind: "accessor",
				name: "value",
				static: false,
				private: false,
				access: {
					has: (obj) => "value" in obj,
					get: (obj) => obj.value,
					set: (obj, value) => {
						obj.value = value;
					}
				},
				metadata: _metadata
			}, _value_initializers, _value_extraInitializers);
			__esDecorate$15(this, null, _label_decorators, {
				kind: "accessor",
				name: "label",
				static: false,
				private: false,
				access: {
					has: (obj) => "label" in obj,
					get: (obj) => obj.label,
					set: (obj, value) => {
						obj.label = value;
					}
				},
				metadata: _metadata
			}, _label_initializers, _label_extraInitializers);
			__esDecorate$15(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Checkbox = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#value_accessor_storage = __runInitializers$15(this, _value_initializers, null);
		get value() {
			return this.#value_accessor_storage;
		}
		set value(value) {
			this.#value_accessor_storage = value;
		}
		#label_accessor_storage = (__runInitializers$15(this, _value_extraInitializers), __runInitializers$15(this, _label_initializers, null));
		get label() {
			return this.#label_accessor_storage;
		}
		set label(value) {
			this.#label_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$10`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      input {
        display: block;
        width: 100%;
      }

      .description {
        font-size: 14px;
        margin-bottom: 4px;
      }
    `];
		}
		#setBoundValue(value) {
			if (!this.value || !this.processor) return;
			if (!("path" in this.value)) return;
			if (!this.value.path) return;
			this.processor.setData(this.component, this.value.path, value, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
		}
		#renderField(value) {
			return b` <section
      class=${e$2(this.theme.components.CheckBox.container)}
      style=${this.theme.additionalStyles?.CheckBox ? o$2(this.theme.additionalStyles?.CheckBox) : A}
    >
      <input
        class=${e$2(this.theme.components.CheckBox.element)}
        autocomplete="off"
        @input=${(evt) => {
				if (!(evt.target instanceof HTMLInputElement)) return;
				this.#setBoundValue(evt.target.checked);
			}}
        id="data"
        type="checkbox"
        .checked=${value}
      />
      <label class=${e$2(this.theme.components.CheckBox.label)} for="data"
        >${extractStringValue(this.label, this.component, this.processor, this.surfaceId)}</label
      >
    </section>`;
		}
		render() {
			if (this.value && typeof this.value === "object") {
				if ("literalBoolean" in this.value && this.value.literalBoolean) return this.#renderField(this.value.literalBoolean);
				else if ("literal" in this.value && this.value.literal !== void 0) return this.#renderField(this.value.literal);
				else if (this.value && "path" in this.value && this.value.path) {
					if (!this.processor || !this.component) return b`(no model)`;
					const textValue = this.processor.getData(this.component, this.value.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (textValue === null) return b`Invalid label`;
					if (typeof textValue !== "boolean") return b`Invalid label`;
					return this.#renderField(textValue);
				}
			}
			return A;
		}
		constructor() {
			super(...arguments);
			__runInitializers$15(this, _label_extraInitializers);
		}
		static {
			__runInitializers$15(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$14 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$14 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-column")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _alignment_decorators;
	let _alignment_initializers = [];
	let _alignment_extraInitializers = [];
	let _distribution_decorators;
	let _distribution_initializers = [];
	let _distribution_extraInitializers = [];
	var Column = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_alignment_decorators = [n$9({
				reflect: true,
				type: String
			})];
			_distribution_decorators = [n$9({
				reflect: true,
				type: String
			})];
			__esDecorate$14(this, null, _alignment_decorators, {
				kind: "accessor",
				name: "alignment",
				static: false,
				private: false,
				access: {
					has: (obj) => "alignment" in obj,
					get: (obj) => obj.alignment,
					set: (obj, value) => {
						obj.alignment = value;
					}
				},
				metadata: _metadata
			}, _alignment_initializers, _alignment_extraInitializers);
			__esDecorate$14(this, null, _distribution_decorators, {
				kind: "accessor",
				name: "distribution",
				static: false,
				private: false,
				access: {
					has: (obj) => "distribution" in obj,
					get: (obj) => obj.distribution,
					set: (obj, value) => {
						obj.distribution = value;
					}
				},
				metadata: _metadata
			}, _distribution_initializers, _distribution_extraInitializers);
			__esDecorate$14(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Column = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#alignment_accessor_storage = __runInitializers$14(this, _alignment_initializers, "stretch");
		get alignment() {
			return this.#alignment_accessor_storage;
		}
		set alignment(value) {
			this.#alignment_accessor_storage = value;
		}
		#distribution_accessor_storage = (__runInitializers$14(this, _alignment_extraInitializers), __runInitializers$14(this, _distribution_initializers, "start"));
		get distribution() {
			return this.#distribution_accessor_storage;
		}
		set distribution(value) {
			this.#distribution_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$10`
      * {
        box-sizing: border-box;
      }

      :host {
        display: flex;
        flex: var(--weight);
      }

      section {
        display: flex;
        flex-direction: column;
        min-width: 100%;
        height: 100%;
      }

      :host([alignment='start']) section {
        align-items: start;
      }

      :host([alignment='center']) section {
        align-items: center;
      }

      :host([alignment='end']) section {
        align-items: end;
      }

      :host([alignment='stretch']) section {
        align-items: stretch;
      }

      :host([distribution='start']) section {
        justify-content: start;
      }

      :host([distribution='center']) section {
        justify-content: center;
      }

      :host([distribution='end']) section {
        justify-content: end;
      }

      :host([distribution='spaceBetween']) section {
        justify-content: space-between;
      }

      :host([distribution='spaceAround']) section {
        justify-content: space-around;
      }

      :host([distribution='spaceEvenly']) section {
        justify-content: space-evenly;
      }
    `];
		}
		render() {
			return b`<section
      class=${e$2(this.theme.components.Column)}
      style=${this.theme.additionalStyles?.Column ? o$2(this.theme.additionalStyles?.Column) : A}
    >
      <slot></slot>
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$14(this, _distribution_extraInitializers);
		}
		static {
			__runInitializers$14(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$13 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$13 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-datetimeinput")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _value_decorators;
	let _value_initializers = [];
	let _value_extraInitializers = [];
	let _label_decorators;
	let _label_initializers = [];
	let _label_extraInitializers = [];
	let _enableDate_decorators;
	let _enableDate_initializers = [];
	let _enableDate_extraInitializers = [];
	let _enableTime_decorators;
	let _enableTime_initializers = [];
	let _enableTime_extraInitializers = [];
	var DateTimeInput = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_value_decorators = [n$9()];
			_label_decorators = [n$9()];
			_enableDate_decorators = [n$9({
				reflect: false,
				type: Boolean
			})];
			_enableTime_decorators = [n$9({
				reflect: false,
				type: Boolean
			})];
			__esDecorate$13(this, null, _value_decorators, {
				kind: "accessor",
				name: "value",
				static: false,
				private: false,
				access: {
					has: (obj) => "value" in obj,
					get: (obj) => obj.value,
					set: (obj, value) => {
						obj.value = value;
					}
				},
				metadata: _metadata
			}, _value_initializers, _value_extraInitializers);
			__esDecorate$13(this, null, _label_decorators, {
				kind: "accessor",
				name: "label",
				static: false,
				private: false,
				access: {
					has: (obj) => "label" in obj,
					get: (obj) => obj.label,
					set: (obj, value) => {
						obj.label = value;
					}
				},
				metadata: _metadata
			}, _label_initializers, _label_extraInitializers);
			__esDecorate$13(this, null, _enableDate_decorators, {
				kind: "accessor",
				name: "enableDate",
				static: false,
				private: false,
				access: {
					has: (obj) => "enableDate" in obj,
					get: (obj) => obj.enableDate,
					set: (obj, value) => {
						obj.enableDate = value;
					}
				},
				metadata: _metadata
			}, _enableDate_initializers, _enableDate_extraInitializers);
			__esDecorate$13(this, null, _enableTime_decorators, {
				kind: "accessor",
				name: "enableTime",
				static: false,
				private: false,
				access: {
					has: (obj) => "enableTime" in obj,
					get: (obj) => obj.enableTime,
					set: (obj, value) => {
						obj.enableTime = value;
					}
				},
				metadata: _metadata
			}, _enableTime_initializers, _enableTime_extraInitializers);
			__esDecorate$13(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			DateTimeInput = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#value_accessor_storage = __runInitializers$13(this, _value_initializers, null);
		get value() {
			return this.#value_accessor_storage;
		}
		set value(value) {
			this.#value_accessor_storage = value;
		}
		#label_accessor_storage = (__runInitializers$13(this, _value_extraInitializers), __runInitializers$13(this, _label_initializers, null));
		get label() {
			return this.#label_accessor_storage;
		}
		set label(value) {
			this.#label_accessor_storage = value;
		}
		#enableDate_accessor_storage = (__runInitializers$13(this, _label_extraInitializers), __runInitializers$13(this, _enableDate_initializers, true));
		get enableDate() {
			return this.#enableDate_accessor_storage;
		}
		set enableDate(value) {
			this.#enableDate_accessor_storage = value;
		}
		#enableTime_accessor_storage = (__runInitializers$13(this, _enableDate_extraInitializers), __runInitializers$13(this, _enableTime_initializers, true));
		get enableTime() {
			return this.#enableTime_accessor_storage;
		}
		set enableTime(value) {
			this.#enableTime_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$10`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      input {
        display: block;
        border-radius: 8px;
        padding: 8px;
        border: 1px solid #ccc;
        width: 100%;
      }
    `];
		}
		#setBoundValue(value) {
			if (!this.value || !this.processor) return;
			if (!("path" in this.value)) return;
			if (!this.value.path) return;
			this.processor.setData(this.component, this.value.path, value, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
		}
		#renderField(value) {
			return b`<section class=${e$2(this.theme.components.DateTimeInput.container)}>
      <label for="data" class=${e$2(this.theme.components.DateTimeInput.label)}
        >${this.#getPlaceholderText()}</label
      >
      <input
        autocomplete="off"
        class=${e$2(this.theme.components.DateTimeInput.element)}
        style=${this.theme.additionalStyles?.DateTimeInput ? o$2(this.theme.additionalStyles?.DateTimeInput) : A}
        @input=${(evt) => {
				if (!(evt.target instanceof HTMLInputElement)) return;
				this.#setBoundValue(evt.target.value);
			}}
        id="data"
        name="data"
        .value=${this.#formatInputValue(value)}
        .placeholder=${this.#getPlaceholderText()}
        .type=${this.#getInputType()}
      />
    </section>`;
		}
		#getInputType() {
			if (this.enableDate && this.enableTime) return "datetime-local";
			else if (this.enableDate) return "date";
			else if (this.enableTime) return "time";
			return "datetime-local";
		}
		#formatInputValue(value) {
			const inputType = this.#getInputType();
			const date = value ? new Date(value) : null;
			if (!date || isNaN(date.getTime())) return "";
			const year = this.#padNumber(date.getFullYear());
			const month = this.#padNumber(date.getMonth() + 1);
			const day = this.#padNumber(date.getDate());
			const hours = this.#padNumber(date.getHours());
			const minutes = this.#padNumber(date.getMinutes());
			if (inputType === "date") return `${year}-${month}-${day}`;
			else if (inputType === "time") return `${hours}:${minutes}`;
			return `${year}-${month}-${day}T${hours}:${minutes}`;
		}
		#padNumber(value) {
			return value.toString().padStart(2, "0");
		}
		#getPlaceholderText() {
			const inputType = this.#getInputType();
			if (inputType === "date") return "Date";
			else if (inputType === "time") return "Time";
			return "Date & Time";
		}
		render() {
			if (this.value && typeof this.value === "object") {
				if ("literalString" in this.value && this.value.literalString) return this.#renderField(this.value.literalString);
				else if ("literal" in this.value && this.value.literal !== void 0) return this.#renderField(this.value.literal);
				else if (this.value && "path" in this.value && this.value.path) {
					if (!this.processor || !this.component) return b`(no model)`;
					const textValue = this.processor.getData(this.component, this.value.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (typeof textValue !== "string") return b`(invalid)`;
					return this.#renderField(textValue);
				}
			}
			return A;
		}
		constructor() {
			super(...arguments);
			__runInitializers$13(this, _enableTime_extraInitializers);
		}
		static {
			__runInitializers$13(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$12 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$12 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-divider")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	var Divider = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			__esDecorate$12(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Divider = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static {
			this.styles = [structuralStyles, i$10`
      :host {
        display: block;
        min-height: 0;
        overflow: auto;
      }

      hr {
        height: 1px;
        background: #ccc;
        border: none;
      }
    `];
		}
		render() {
			return b`<hr
      class=${e$2(this.theme.components.Divider)}
      style=${this.theme.additionalStyles?.Divider ? o$2(this.theme.additionalStyles?.Divider) : A}
    />`;
		}
		static {
			__runInitializers$12(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$11 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$11 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-icon")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _name_decorators;
	let _name_initializers = [];
	let _name_extraInitializers = [];
	var Icon = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_name_decorators = [n$9()];
			__esDecorate$11(this, null, _name_decorators, {
				kind: "accessor",
				name: "name",
				static: false,
				private: false,
				access: {
					has: (obj) => "name" in obj,
					get: (obj) => obj.name,
					set: (obj, value) => {
						obj.name = value;
					}
				},
				metadata: _metadata
			}, _name_initializers, _name_extraInitializers);
			__esDecorate$11(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Icon = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#name_accessor_storage = __runInitializers$11(this, _name_initializers, null);
		get name() {
			return this.#name_accessor_storage;
		}
		set name(value) {
			this.#name_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$10`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
      }

      .g-icon {
        font-family: 'Material Symbols Outlined';
        font-weight: normal;
        font-style: normal;
        font-size: 24px;
        display: inline-block;
        line-height: 1;
        text-transform: none;
        letter-spacing: normal;
        word-wrap: normal;
        white-space: nowrap;
        direction: ltr;
        -webkit-font-smoothing: antialiased;
        text-rendering: optimizeLegibility;
        -moz-osx-font-smoothing: grayscale;
        font-feature-settings: 'liga';
      }
    `];
		}
		#renderIcon() {
			if (!this.name) return A;
			const render = (url) => {
				url = url.replace(/([A-Z])/gm, "_$1").toLocaleLowerCase();
				return b`<span class="g-icon">${url}</span>`;
			};
			if (this.name && typeof this.name === "object") {
				if ("literalString" in this.name) return render(this.name.literalString ?? "");
				else if ("literal" in this.name) return render(this.name.literal ?? "");
				else if (this.name && "path" in this.name && this.name.path) {
					if (!this.processor || !this.component) return b`(no model)`;
					const iconName = this.processor.getData(this.component, this.name.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (!iconName) return b`Invalid icon name`;
					if (typeof iconName !== "string") return b`Invalid icon name`;
					return render(iconName);
				}
			}
			return b`(empty)`;
		}
		render() {
			return b`<section
      class=${e$2(this.theme.components.Icon)}
      style=${this.theme.additionalStyles?.Icon ? o$2(this.theme.additionalStyles?.Icon) : A}
    >
      ${this.#renderIcon()}
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$11(this, _name_extraInitializers);
		}
		static {
			__runInitializers$11(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$10 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$10 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-image")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _url_decorators;
	let _url_initializers = [];
	let _url_extraInitializers = [];
	let _altText_decorators;
	let _altText_initializers = [];
	let _altText_extraInitializers = [];
	let _usageHint_decorators;
	let _usageHint_initializers = [];
	let _usageHint_extraInitializers = [];
	let _fit_decorators;
	let _fit_initializers = [];
	let _fit_extraInitializers = [];
	var Image = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_url_decorators = [n$9()];
			_altText_decorators = [n$9()];
			_usageHint_decorators = [n$9()];
			_fit_decorators = [n$9()];
			__esDecorate$10(this, null, _url_decorators, {
				kind: "accessor",
				name: "url",
				static: false,
				private: false,
				access: {
					has: (obj) => "url" in obj,
					get: (obj) => obj.url,
					set: (obj, value) => {
						obj.url = value;
					}
				},
				metadata: _metadata
			}, _url_initializers, _url_extraInitializers);
			__esDecorate$10(this, null, _altText_decorators, {
				kind: "accessor",
				name: "altText",
				static: false,
				private: false,
				access: {
					has: (obj) => "altText" in obj,
					get: (obj) => obj.altText,
					set: (obj, value) => {
						obj.altText = value;
					}
				},
				metadata: _metadata
			}, _altText_initializers, _altText_extraInitializers);
			__esDecorate$10(this, null, _usageHint_decorators, {
				kind: "accessor",
				name: "usageHint",
				static: false,
				private: false,
				access: {
					has: (obj) => "usageHint" in obj,
					get: (obj) => obj.usageHint,
					set: (obj, value) => {
						obj.usageHint = value;
					}
				},
				metadata: _metadata
			}, _usageHint_initializers, _usageHint_extraInitializers);
			__esDecorate$10(this, null, _fit_decorators, {
				kind: "accessor",
				name: "fit",
				static: false,
				private: false,
				access: {
					has: (obj) => "fit" in obj,
					get: (obj) => obj.fit,
					set: (obj, value) => {
						obj.fit = value;
					}
				},
				metadata: _metadata
			}, _fit_initializers, _fit_extraInitializers);
			__esDecorate$10(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Image = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#url_accessor_storage = __runInitializers$10(this, _url_initializers, null);
		get url() {
			return this.#url_accessor_storage;
		}
		set url(value) {
			this.#url_accessor_storage = value;
		}
		#altText_accessor_storage = (__runInitializers$10(this, _url_extraInitializers), __runInitializers$10(this, _altText_initializers, null));
		get altText() {
			return this.#altText_accessor_storage;
		}
		set altText(value) {
			this.#altText_accessor_storage = value;
		}
		#usageHint_accessor_storage = (__runInitializers$10(this, _altText_extraInitializers), __runInitializers$10(this, _usageHint_initializers, null));
		get usageHint() {
			return this.#usageHint_accessor_storage;
		}
		set usageHint(value) {
			this.#usageHint_accessor_storage = value;
		}
		#fit_accessor_storage = (__runInitializers$10(this, _usageHint_extraInitializers), __runInitializers$10(this, _fit_initializers, null));
		get fit() {
			return this.#fit_accessor_storage;
		}
		set fit(value) {
			this.#fit_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$10`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: var(--object-fit, fill);
      }
    `];
		}
		#renderImage() {
			if (!this.url) return A;
			const render = (url) => {
				let resolvedAlt = "";
				if (this.altText) {
					if (typeof this.altText === "object") {
						if ("literalString" in this.altText) resolvedAlt = this.altText.literalString ?? "";
						else if ("literal" in this.altText) resolvedAlt = this.altText.literal ?? "";
						else if ("path" in this.altText && this.altText.path) {
							if (this.processor && this.component) {
								const data = this.processor.getData(this.component, this.altText.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
								if (typeof data === "string") resolvedAlt = data;
							}
						}
					}
				}
				return b`<img src=${url} alt=${resolvedAlt} />`;
			};
			if (this.url && typeof this.url === "object") {
				if ("literalString" in this.url) return render(this.url.literalString ?? "");
				else if ("literal" in this.url) return render(this.url.literal ?? "");
				else if (this.url && "path" in this.url && this.url.path) {
					if (!this.processor || !this.component) return b`(no model)`;
					const imageUrl = this.processor.getData(this.component, this.url.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (!imageUrl) return b`Invalid image URL`;
					if (typeof imageUrl !== "string") return b`Invalid image URL`;
					return render(imageUrl);
				}
			}
			return b`(empty)`;
		}
		render() {
			return b`<section
      class=${e$2(merge(this.theme.components.Image.all, this.usageHint ? this.theme.components.Image[this.usageHint] : {}))}
      style=${o$2({
				...this.theme.additionalStyles?.Image ?? {},
				"--object-fit": this.fit ?? "fill"
			})}
    >
      ${this.#renderImage()}
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$10(this, _fit_extraInitializers);
		}
		static {
			__runInitializers$10(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$9 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$9 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-list")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _direction_decorators;
	let _direction_initializers = [];
	let _direction_extraInitializers = [];
	var List = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_direction_decorators = [n$9({
				reflect: true,
				type: String
			})];
			__esDecorate$9(this, null, _direction_decorators, {
				kind: "accessor",
				name: "direction",
				static: false,
				private: false,
				access: {
					has: (obj) => "direction" in obj,
					get: (obj) => obj.direction,
					set: (obj, value) => {
						obj.direction = value;
					}
				},
				metadata: _metadata
			}, _direction_initializers, _direction_extraInitializers);
			__esDecorate$9(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			List = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#direction_accessor_storage = __runInitializers$9(this, _direction_initializers, "vertical");
		get direction() {
			return this.#direction_accessor_storage;
		}
		set direction(value) {
			this.#direction_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$10`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      :host([direction='vertical']) section {
        display: grid;
      }

      :host([direction='horizontal']) section {
        display: flex;
        max-width: 100%;
        overflow-x: scroll;
        overflow-y: hidden;
        scrollbar-width: none;

        > ::slotted(*) {
          flex: 1 0 fit-content;
          max-width: min(80%, 400px);
        }
      }
    `];
		}
		render() {
			return b`<section
      class=${e$2(this.theme.components.List)}
      style=${this.theme.additionalStyles?.List ? o$2(this.theme.additionalStyles?.List) : A}
    >
      <slot></slot>
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$9(this, _direction_extraInitializers);
		}
		static {
			__runInitializers$9(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$8 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$8 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-multiplechoice")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _description_decorators;
	let _description_initializers = [];
	let _description_extraInitializers = [];
	let _options_decorators;
	let _options_initializers = [];
	let _options_extraInitializers = [];
	let _selections_decorators;
	let _selections_initializers = [];
	let _selections_extraInitializers = [];
	let _variant_decorators;
	let _variant_initializers = [];
	let _variant_extraInitializers = [];
	let _filterable_decorators;
	let _filterable_initializers = [];
	let _filterable_extraInitializers = [];
	let _isOpen_decorators;
	let _isOpen_initializers = [];
	let _isOpen_extraInitializers = [];
	let _filterText_decorators;
	let _filterText_initializers = [];
	let _filterText_extraInitializers = [];
	var MultipleChoice = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_description_decorators = [n$9()];
			_options_decorators = [n$9()];
			_selections_decorators = [n$9()];
			_variant_decorators = [n$9()];
			_filterable_decorators = [n$9({ type: Boolean })];
			_isOpen_decorators = [r$7()];
			_filterText_decorators = [r$7()];
			__esDecorate$8(this, null, _description_decorators, {
				kind: "accessor",
				name: "description",
				static: false,
				private: false,
				access: {
					has: (obj) => "description" in obj,
					get: (obj) => obj.description,
					set: (obj, value) => {
						obj.description = value;
					}
				},
				metadata: _metadata
			}, _description_initializers, _description_extraInitializers);
			__esDecorate$8(this, null, _options_decorators, {
				kind: "accessor",
				name: "options",
				static: false,
				private: false,
				access: {
					has: (obj) => "options" in obj,
					get: (obj) => obj.options,
					set: (obj, value) => {
						obj.options = value;
					}
				},
				metadata: _metadata
			}, _options_initializers, _options_extraInitializers);
			__esDecorate$8(this, null, _selections_decorators, {
				kind: "accessor",
				name: "selections",
				static: false,
				private: false,
				access: {
					has: (obj) => "selections" in obj,
					get: (obj) => obj.selections,
					set: (obj, value) => {
						obj.selections = value;
					}
				},
				metadata: _metadata
			}, _selections_initializers, _selections_extraInitializers);
			__esDecorate$8(this, null, _variant_decorators, {
				kind: "accessor",
				name: "variant",
				static: false,
				private: false,
				access: {
					has: (obj) => "variant" in obj,
					get: (obj) => obj.variant,
					set: (obj, value) => {
						obj.variant = value;
					}
				},
				metadata: _metadata
			}, _variant_initializers, _variant_extraInitializers);
			__esDecorate$8(this, null, _filterable_decorators, {
				kind: "accessor",
				name: "filterable",
				static: false,
				private: false,
				access: {
					has: (obj) => "filterable" in obj,
					get: (obj) => obj.filterable,
					set: (obj, value) => {
						obj.filterable = value;
					}
				},
				metadata: _metadata
			}, _filterable_initializers, _filterable_extraInitializers);
			__esDecorate$8(this, null, _isOpen_decorators, {
				kind: "accessor",
				name: "isOpen",
				static: false,
				private: false,
				access: {
					has: (obj) => "isOpen" in obj,
					get: (obj) => obj.isOpen,
					set: (obj, value) => {
						obj.isOpen = value;
					}
				},
				metadata: _metadata
			}, _isOpen_initializers, _isOpen_extraInitializers);
			__esDecorate$8(this, null, _filterText_decorators, {
				kind: "accessor",
				name: "filterText",
				static: false,
				private: false,
				access: {
					has: (obj) => "filterText" in obj,
					get: (obj) => obj.filterText,
					set: (obj, value) => {
						obj.filterText = value;
					}
				},
				metadata: _metadata
			}, _filterText_initializers, _filterText_extraInitializers);
			__esDecorate$8(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			MultipleChoice = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#description_accessor_storage = __runInitializers$8(this, _description_initializers, null);
		get description() {
			return this.#description_accessor_storage;
		}
		set description(value) {
			this.#description_accessor_storage = value;
		}
		#options_accessor_storage = (__runInitializers$8(this, _description_extraInitializers), __runInitializers$8(this, _options_initializers, []));
		get options() {
			return this.#options_accessor_storage;
		}
		set options(value) {
			this.#options_accessor_storage = value;
		}
		#selections_accessor_storage = (__runInitializers$8(this, _options_extraInitializers), __runInitializers$8(this, _selections_initializers, []));
		get selections() {
			return this.#selections_accessor_storage;
		}
		set selections(value) {
			this.#selections_accessor_storage = value;
		}
		#variant_accessor_storage = (__runInitializers$8(this, _selections_extraInitializers), __runInitializers$8(this, _variant_initializers, "checkbox"));
		get variant() {
			return this.#variant_accessor_storage;
		}
		set variant(value) {
			this.#variant_accessor_storage = value;
		}
		#filterable_accessor_storage = (__runInitializers$8(this, _variant_extraInitializers), __runInitializers$8(this, _filterable_initializers, false));
		get filterable() {
			return this.#filterable_accessor_storage;
		}
		set filterable(value) {
			this.#filterable_accessor_storage = value;
		}
		#isOpen_accessor_storage = (__runInitializers$8(this, _filterable_extraInitializers), __runInitializers$8(this, _isOpen_initializers, false));
		get isOpen() {
			return this.#isOpen_accessor_storage;
		}
		set isOpen(value) {
			this.#isOpen_accessor_storage = value;
		}
		#filterText_accessor_storage = (__runInitializers$8(this, _isOpen_extraInitializers), __runInitializers$8(this, _filterText_initializers, ""));
		get filterText() {
			return this.#filterText_accessor_storage;
		}
		set filterText(value) {
			this.#filterText_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$10`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        position: relative;
        font-family: 'Google Sans', 'Roboto', sans-serif;
      }

      .container {
        display: flex;
        flex-direction: column;
        gap: 4px;
        position: relative;
      }

      /* Header / Trigger */
      .dropdown-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        background: var(--md-sys-color-surface);
        border: 1px solid var(--md-sys-color-outline-variant);
        border-radius: 8px;
        cursor: pointer;
        user-select: none;
        transition: background-color 0.2s;
        box-shadow: var(--md-sys-elevation-level1);
      }

      .dropdown-header:hover {
        background: var(--md-sys-color-surface-container-low);
      }

      .header-text {
        font-size: 1rem;
        color: var(--md-sys-color-on-surface);
        font-weight: 400;
      }

      .chevron {
        color: var(--md-sys-color-primary);
        font-size: 1.2rem;
        transition: transform 0.2s ease;
      }

      .chevron.open {
        transform: rotate(180deg);
      }

      /* Dropdown Wrapper */
      .dropdown-wrapper {
        background: var(--md-sys-color-surface);
        border: 1px solid var(--md-sys-color-outline-variant);
        border-radius: 8px;
        box-shadow: var(--md-sys-elevation-level2);
        padding: 0;
        display: none;
        flex-direction: column;
        margin-top: 4px;
        max-height: 300px;
        transition: opacity 0.2s ease-out;
        overflow: hidden; /* contain children */
      }

      .dropdown-wrapper.open {
        display: flex;
        border: 1px solid var(--md-sys-color-outline-variant);
      }

      /* Scrollable Area for Options */
      .options-scroll-container {
        overflow-y: auto;
        flex: 1; /* take remaining height */
        display: flex;
        flex-direction: column;
      }

      /* Filter Input */
      .filter-container {
        padding: 8px;
        border-bottom: 1px solid var(--md-sys-color-outline-variant);
        background: var(--md-sys-color-surface);
        z-index: 1; /* ensure top of stack */
        flex-shrink: 0; /* don't shrink */
      }

      .filter-input {
        width: 100%;
        padding: 8px 12px;
        border: 1px solid var(--md-sys-color-outline);
        border-radius: 4px;
        font-family: inherit;
        font-size: 0.9rem;
        background: var(--md-sys-color-surface-container-low);
        color: var(--md-sys-color-on-surface);
      }

      .filter-input:focus {
        outline: none;
        border-color: var(--md-sys-color-primary);
      }

      /* Option Item (Checkbox style) */
      .option-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        cursor: pointer;
        color: var(--md-sys-color-on-surface);
        font-size: 0.95rem;
        transition: background-color 0.1s;
      }

      .option-item:hover {
        background: var(--md-sys-color-surface-container-highest);
      }

      /* Custom Checkbox */
      .checkbox {
        width: 18px;
        height: 18px;
        border: 2px solid var(--md-sys-color-outline);
        border-radius: 2px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        flex-shrink: 0;
      }

      .option-item.selected .checkbox {
        background: var(--md-sys-color-primary);
        border-color: var(--md-sys-color-primary);
      }

      .checkbox-icon {
        color: var(--md-sys-color-on-primary);
        font-size: 14px;
        font-weight: bold;
        opacity: 0;
        transform: scale(0.5);
        transition: all 0.2s;
      }

      .option-item.selected .checkbox-icon {
        opacity: 1;
        transform: scale(1);
      }

      /* Chips Layout */
      .chips-container {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding: 4px 0;
      }

      .chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 16px;
        border: 1px solid var(--md-sys-color-outline);
        border-radius: 16px;
        cursor: pointer;
        user-select: none;
        background: var(--md-sys-color-surface);
        color: var(--md-sys-color-on-surface);
        transition: all 0.2s ease;
        font-size: 0.9rem;
      }

      .chip:hover {
        background: var(--md-sys-color-surface-container-high);
      }

      .chip.selected {
        background: var(--md-sys-color-secondary-container);
        color: var(--md-sys-color-on-secondary-container);
        border-color: var(--md-sys-color-secondary-container);
      }

      .chip.selected:hover {
        background: var(--md-sys-color-secondary-container-high);
      }

      .chip-icon {
        display: none;
        width: 18px;
        height: 18px;
      }

      .chip.selected .chip-icon {
        display: block;
        fill: currentColor;
      }

      @keyframes fadeIn {
        from {
          opacity: 0;
          transform: translateY(-8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    `];
		}
		#setBoundValue(value) {
			if (!this.selections || !this.processor) return;
			if (!("path" in this.selections)) return;
			if (!this.selections.path) return;
			this.processor.setData(this.component, this.selections.path, value, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
		}
		getCurrentSelections() {
			if (Array.isArray(this.selections)) return this.selections;
			if (!this.processor || !this.component) return [];
			const selectionValue = this.processor.getData(this.component, this.selections.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
			return Array.isArray(selectionValue) ? selectionValue : [];
		}
		toggleSelection(value) {
			const current = this.getCurrentSelections();
			if (current.includes(value)) this.#setBoundValue(current.filter((v) => v !== value));
			else this.#setBoundValue([...current, value]);
			this.requestUpdate();
		}
		#renderCheckIcon() {
			return b`
      <svg class="chip-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960">
        <path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z" />
      </svg>
    `;
		}
		#renderFilter() {
			return b`
      <div class="filter-container">
        <input
          type="text"
          class="filter-input"
          placeholder="Filter options..."
          .value=${this.filterText}
          @input=${(e) => {
				const target = e.target;
				this.filterText = target.value;
			}}
          @click=${(e) => e.stopPropagation()}
        />
      </div>
    `;
		}
		render() {
			const currentSelections = this.getCurrentSelections();
			const filteredOptions = this.options.filter((option) => {
				if (!this.filterText) return true;
				return extractStringValue(option.label, this.component, this.processor, this.surfaceId).toLowerCase().includes(this.filterText.toLowerCase());
			});
			if (this.variant === "chips") return b`
        <div class="container">
          ${this.description ? b`<div class="header-text" style="margin-bottom: 8px;">${this.description}</div>` : A}
          ${this.filterable ? this.#renderFilter() : A}
          <div class="chips-container">
            ${filteredOptions.map((option) => {
				const label = extractStringValue(option.label, this.component, this.processor, this.surfaceId);
				const isSelected = currentSelections.includes(option.value);
				return b`
                <div
                  class="chip ${isSelected ? "selected" : ""}"
                  @click=${(e) => {
					e.stopPropagation();
					this.toggleSelection(option.value);
				}}
                >
                  ${isSelected ? this.#renderCheckIcon() : A}
                  <span>${label}</span>
                </div>
              `;
			})}
          </div>
          ${filteredOptions.length === 0 ? b`<div
                style="padding: 8px; font-style: italic; color: var(--md-sys-color-outline);"
              >
                No options found
              </div>` : A}
        </div>
      `;
			const count = currentSelections.length;
			return b`
      <div class="container">
        <div class="dropdown-header" @click=${() => this.isOpen = !this.isOpen}>
          <span class="header-text">${count > 0 ? `${count} Selected` : this.description ?? "Select items"}</span>
          <span class="chevron ${this.isOpen ? "open" : ""}">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="24"
              viewBox="0 -960 960 960"
              width="24"
              fill="currentColor"
            >
              <path d="M480-345 240-585l56-56 184 184 184-184 56 56-240 240Z" />
            </svg>
          </span>
        </div>

        <div class="dropdown-wrapper ${this.isOpen ? "open" : ""}">
          ${this.filterable ? this.#renderFilter() : A}
          <div class="options-scroll-container">
            ${filteredOptions.map((option) => {
				const label = extractStringValue(option.label, this.component, this.processor, this.surfaceId);
				return b`
                <div
                  class="option-item ${currentSelections.includes(option.value) ? "selected" : ""}"
                  @click=${(e) => {
					e.stopPropagation();
					this.toggleSelection(option.value);
				}}
                >
                  <div class="checkbox">
                    <span class="checkbox-icon">✓</span>
                  </div>
                  <span>${label}</span>
                </div>
              `;
			})}
            ${filteredOptions.length === 0 ? b`<div
                  style="padding: 16px; text-align: center; color: var(--md-sys-color-outline);"
                >
                  No options found
                </div>` : A}
          </div>
        </div>
      </div>
    `;
		}
		constructor() {
			super(...arguments);
			__runInitializers$8(this, _filterText_extraInitializers);
		}
		static {
			__runInitializers$8(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
/**
* @license
* Copyright 2020 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
const o$1 = /* @__PURE__ */ new WeakMap(), n$1 = e$6(class extends f {
	render(i) {
		return A;
	}
	update(i, [s]) {
		const e = s !== this.G;
		return e && this.rt(void 0), (e || this.lt !== this.ct) && (this.G = s, this.ht = i.options?.host, this.rt(this.ct = i.element)), A;
	}
	rt(t) {
		if (void 0 !== this.G) if (this.isConnected || (t = void 0), "function" == typeof this.G) {
			const i = this.ht ?? globalThis;
			let s = o$1.get(i);
			void 0 === s && (s = /* @__PURE__ */ new WeakMap(), o$1.set(i, s)), void 0 !== s.get(this.G) && this.G.call(this.ht, void 0), s.set(this.G, t), void 0 !== t && this.G.call(this.ht, t);
		} else this.G.value = t;
	}
	get lt() {
		return "function" == typeof this.G ? o$1.get(this.ht ?? globalThis)?.get(this.G) : this.G?.value;
	}
	disconnected() {
		this.lt === this.ct && this.rt(void 0);
	}
	reconnected() {
		this.rt(this.ct);
	}
});
var __esDecorate$7 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$7 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __setFunctionName = function(f, name, prefix) {
	if (typeof name === "symbol") name = name.description ? "[".concat(name.description, "]") : "";
	return Object.defineProperty(f, "name", {
		configurable: true,
		value: prefix ? "".concat(prefix, " ", name) : name
	});
};
(() => {
	let _classDecorators = [t$5("a2ui-modal")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _private_showModal_decorators;
	let _private_showModal_initializers = [];
	let _private_showModal_extraInitializers = [];
	let _private_showModal_descriptor;
	let _private_modalRef_decorators;
	let _private_modalRef_initializers = [];
	let _private_modalRef_extraInitializers = [];
	let _private_modalRef_descriptor;
	var Modal = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_private_showModal_decorators = [r$7()];
			_private_modalRef_decorators = [e$9("dialog")];
			__esDecorate$7(this, _private_showModal_descriptor = {
				get: __setFunctionName(function() {
					return this.#showModal_accessor_storage;
				}, "#showModal", "get"),
				set: __setFunctionName(function(value) {
					this.#showModal_accessor_storage = value;
				}, "#showModal", "set")
			}, _private_showModal_decorators, {
				kind: "accessor",
				name: "#showModal",
				static: false,
				private: true,
				access: {
					has: (obj) => #showModal in obj,
					get: (obj) => obj.#showModal,
					set: (obj, value) => {
						obj.#showModal = value;
					}
				},
				metadata: _metadata
			}, _private_showModal_initializers, _private_showModal_extraInitializers);
			__esDecorate$7(this, _private_modalRef_descriptor = {
				get: __setFunctionName(function() {
					return this.#modalRef_accessor_storage;
				}, "#modalRef", "get"),
				set: __setFunctionName(function(value) {
					this.#modalRef_accessor_storage = value;
				}, "#modalRef", "set")
			}, _private_modalRef_decorators, {
				kind: "accessor",
				name: "#modalRef",
				static: false,
				private: true,
				access: {
					has: (obj) => #modalRef in obj,
					get: (obj) => obj.#modalRef,
					set: (obj, value) => {
						obj.#modalRef = value;
					}
				},
				metadata: _metadata
			}, _private_modalRef_initializers, _private_modalRef_extraInitializers);
			__esDecorate$7(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Modal = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static {
			this.styles = [structuralStyles, i$10`
      * {
        box-sizing: border-box;
      }

      dialog {
        padding: 0 0 0 0;
        border: none;
        background: none;

        & section {
          & #controls {
            display: flex;
            justify-content: end;
            margin-bottom: 4px;

            & button {
              padding: 0;
              background: none;
              width: 20px;
              height: 20px;
              pointer: cursor;
              border: none;
              cursor: pointer;
            }
          }
        }
      }
    `];
		}
		#showModal_accessor_storage = __runInitializers$7(this, _private_showModal_initializers, false);
		get #showModal() {
			return _private_showModal_descriptor.get.call(this);
		}
		set #showModal(value) {
			return _private_showModal_descriptor.set.call(this, value);
		}
		#modalRef_accessor_storage = (__runInitializers$7(this, _private_showModal_extraInitializers), __runInitializers$7(this, _private_modalRef_initializers, null));
		get #modalRef() {
			return _private_modalRef_descriptor.get.call(this);
		}
		set #modalRef(value) {
			return _private_modalRef_descriptor.set.call(this, value);
		}
		#closeModal() {
			if (!this.#modalRef) return;
			if (this.#modalRef.open) this.#modalRef.close();
			this.#showModal = false;
		}
		render() {
			if (!this.#showModal) return b`<section
        @click=${() => {
				this.#showModal = true;
			}}
      >
        <slot name="entry"></slot>
      </section>`;
			return b`<dialog
      class=${e$2(this.theme.components.Modal.backdrop)}
      @click=${(evt) => {
				const [top] = evt.composedPath();
				if (!(top instanceof HTMLDialogElement)) return;
				this.#closeModal();
			}}
      ${n$1((el) => {
				const showModalIfNeeded = () => {
					if (!(el && el instanceof HTMLDialogElement) || el.open) return;
					el.showModal();
				};
				requestAnimationFrame(showModalIfNeeded);
			})}
    >
      <section
        class=${e$2(this.theme.components.Modal.element)}
        style=${this.theme.additionalStyles?.Modal ? o$2(this.theme.additionalStyles?.Modal) : A}
      >
        <div id="controls">
          <button
            @click=${() => {
				this.#closeModal();
			}}
          >
            <span class="g-icon">close</span>
          </button>
        </div>
        <slot></slot>
      </section>
    </dialog>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$7(this, _private_modalRef_extraInitializers);
		}
		static {
			__runInitializers$7(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$6 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$6 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-row")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _alignment_decorators;
	let _alignment_initializers = [];
	let _alignment_extraInitializers = [];
	let _distribution_decorators;
	let _distribution_initializers = [];
	let _distribution_extraInitializers = [];
	var Row = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_alignment_decorators = [n$9({
				reflect: true,
				type: String
			})];
			_distribution_decorators = [n$9({
				reflect: true,
				type: String
			})];
			__esDecorate$6(this, null, _alignment_decorators, {
				kind: "accessor",
				name: "alignment",
				static: false,
				private: false,
				access: {
					has: (obj) => "alignment" in obj,
					get: (obj) => obj.alignment,
					set: (obj, value) => {
						obj.alignment = value;
					}
				},
				metadata: _metadata
			}, _alignment_initializers, _alignment_extraInitializers);
			__esDecorate$6(this, null, _distribution_decorators, {
				kind: "accessor",
				name: "distribution",
				static: false,
				private: false,
				access: {
					has: (obj) => "distribution" in obj,
					get: (obj) => obj.distribution,
					set: (obj, value) => {
						obj.distribution = value;
					}
				},
				metadata: _metadata
			}, _distribution_initializers, _distribution_extraInitializers);
			__esDecorate$6(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Row = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#alignment_accessor_storage = __runInitializers$6(this, _alignment_initializers, "stretch");
		get alignment() {
			return this.#alignment_accessor_storage;
		}
		set alignment(value) {
			this.#alignment_accessor_storage = value;
		}
		#distribution_accessor_storage = (__runInitializers$6(this, _alignment_extraInitializers), __runInitializers$6(this, _distribution_initializers, "start"));
		get distribution() {
			return this.#distribution_accessor_storage;
		}
		set distribution(value) {
			this.#distribution_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$10`
      * {
        box-sizing: border-box;
      }

      :host {
        display: flex;
        flex: var(--weight);
      }

      section {
        display: flex;
        flex-direction: row;
        width: 100%;
        min-height: 100%;
      }

      :host([alignment='start']) section {
        align-items: start;
      }

      :host([alignment='center']) section {
        align-items: center;
      }

      :host([alignment='end']) section {
        align-items: end;
      }

      :host([alignment='stretch']) section {
        align-items: stretch;
      }

      :host([distribution='start']) section {
        justify-content: start;
      }

      :host([distribution='center']) section {
        justify-content: center;
      }

      :host([distribution='end']) section {
        justify-content: end;
      }

      :host([distribution='spaceBetween']) section {
        justify-content: space-between;
      }

      :host([distribution='spaceAround']) section {
        justify-content: space-around;
      }

      :host([distribution='spaceEvenly']) section {
        justify-content: space-evenly;
      }
    `];
		}
		render() {
			return b`<section
      class=${e$2(this.theme.components.Row)}
      style=${this.theme.additionalStyles?.Row ? o$2(this.theme.additionalStyles?.Row) : A}
    >
      <slot></slot>
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$6(this, _distribution_extraInitializers);
		}
		static {
			__runInitializers$6(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$5 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$5 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-slider")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _value_decorators;
	let _value_initializers = [];
	let _value_extraInitializers = [];
	let _minValue_decorators;
	let _minValue_initializers = [];
	let _minValue_extraInitializers = [];
	let _maxValue_decorators;
	let _maxValue_initializers = [];
	let _maxValue_extraInitializers = [];
	let _label_decorators;
	let _label_initializers = [];
	let _label_extraInitializers = [];
	var Slider = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_value_decorators = [n$9()];
			_minValue_decorators = [n$9()];
			_maxValue_decorators = [n$9()];
			_label_decorators = [n$9()];
			__esDecorate$5(this, null, _value_decorators, {
				kind: "accessor",
				name: "value",
				static: false,
				private: false,
				access: {
					has: (obj) => "value" in obj,
					get: (obj) => obj.value,
					set: (obj, value) => {
						obj.value = value;
					}
				},
				metadata: _metadata
			}, _value_initializers, _value_extraInitializers);
			__esDecorate$5(this, null, _minValue_decorators, {
				kind: "accessor",
				name: "minValue",
				static: false,
				private: false,
				access: {
					has: (obj) => "minValue" in obj,
					get: (obj) => obj.minValue,
					set: (obj, value) => {
						obj.minValue = value;
					}
				},
				metadata: _metadata
			}, _minValue_initializers, _minValue_extraInitializers);
			__esDecorate$5(this, null, _maxValue_decorators, {
				kind: "accessor",
				name: "maxValue",
				static: false,
				private: false,
				access: {
					has: (obj) => "maxValue" in obj,
					get: (obj) => obj.maxValue,
					set: (obj, value) => {
						obj.maxValue = value;
					}
				},
				metadata: _metadata
			}, _maxValue_initializers, _maxValue_extraInitializers);
			__esDecorate$5(this, null, _label_decorators, {
				kind: "accessor",
				name: "label",
				static: false,
				private: false,
				access: {
					has: (obj) => "label" in obj,
					get: (obj) => obj.label,
					set: (obj, value) => {
						obj.label = value;
					}
				},
				metadata: _metadata
			}, _label_initializers, _label_extraInitializers);
			__esDecorate$5(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Slider = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#value_accessor_storage = __runInitializers$5(this, _value_initializers, null);
		get value() {
			return this.#value_accessor_storage;
		}
		set value(value) {
			this.#value_accessor_storage = value;
		}
		#minValue_accessor_storage = (__runInitializers$5(this, _value_extraInitializers), __runInitializers$5(this, _minValue_initializers, 0));
		get minValue() {
			return this.#minValue_accessor_storage;
		}
		set minValue(value) {
			this.#minValue_accessor_storage = value;
		}
		#maxValue_accessor_storage = (__runInitializers$5(this, _minValue_extraInitializers), __runInitializers$5(this, _maxValue_initializers, 0));
		get maxValue() {
			return this.#maxValue_accessor_storage;
		}
		set maxValue(value) {
			this.#maxValue_accessor_storage = value;
		}
		#label_accessor_storage = (__runInitializers$5(this, _maxValue_extraInitializers), __runInitializers$5(this, _label_initializers, null));
		get label() {
			return this.#label_accessor_storage;
		}
		set label(value) {
			this.#label_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$10`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
      }

      input {
        display: block;
        width: 100%;
      }

      .description {
      }
    `];
		}
		#setBoundValue(value) {
			if (!this.value || !this.processor) return;
			if (!("path" in this.value)) return;
			if (!this.value.path) return;
			this.processor.setData(this.component, this.value.path, value, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
		}
		#renderField(value) {
			return b`<section class=${e$2(this.theme.components.Slider.container)}>
      ${this.label ? b`<label class=${e$2(this.theme.components.Slider.label)} for="data">
            ${extractStringValue(this.label, this.component, this.processor, this.surfaceId)}
          </label>` : A}
      <input
        autocomplete="off"
        class=${e$2(this.theme.components.Slider.element)}
        style=${this.theme.additionalStyles?.Slider ? o$2(this.theme.additionalStyles?.Slider) : A}
        @input=${(evt) => {
				if (!(evt.target instanceof HTMLInputElement)) return;
				this.#setBoundValue(evt.target.value);
			}}
        id="data"
        name="data"
        .value=${value}
        type="range"
        min=${this.minValue ?? "0"}
        max=${this.maxValue ?? "0"}
      />
      <span class=${e$2(this.theme.components.Slider.label)}
        >${this.value ? extractNumberValue(this.value, this.component, this.processor, this.surfaceId) : "0"}</span
      >
    </section>`;
		}
		render() {
			if (this.value && typeof this.value === "object") {
				if ("literalNumber" in this.value && this.value.literalNumber) return this.#renderField(this.value.literalNumber);
				else if ("literal" in this.value && this.value.literal !== void 0) return this.#renderField(this.value.literal);
				else if (this.value && "path" in this.value && this.value.path) {
					if (!this.processor || !this.component) return b`(no processor)`;
					const textValue = this.processor.getData(this.component, this.value.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (textValue === null) return b`Invalid value`;
					if (typeof textValue !== "string" && typeof textValue !== "number") return b`Invalid value`;
					return this.#renderField(textValue);
				}
			}
			return A;
		}
		constructor() {
			super(...arguments);
			__runInitializers$5(this, _label_extraInitializers);
		}
		static {
			__runInitializers$5(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$4 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$4 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-surface")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _surfaceId_decorators;
	let _surfaceId_initializers = [];
	let _surfaceId_extraInitializers = [];
	let _surface_decorators;
	let _surface_initializers = [];
	let _surface_extraInitializers = [];
	let _processor_decorators;
	let _processor_initializers = [];
	let _processor_extraInitializers = [];
	let _enableCustomElements_decorators;
	let _enableCustomElements_initializers = [];
	let _enableCustomElements_extraInitializers = [];
	var Surface = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_surfaceId_decorators = [n$9()];
			_surface_decorators = [n$9()];
			_processor_decorators = [n$9()];
			_enableCustomElements_decorators = [n$9()];
			__esDecorate$4(this, null, _surfaceId_decorators, {
				kind: "accessor",
				name: "surfaceId",
				static: false,
				private: false,
				access: {
					has: (obj) => "surfaceId" in obj,
					get: (obj) => obj.surfaceId,
					set: (obj, value) => {
						obj.surfaceId = value;
					}
				},
				metadata: _metadata
			}, _surfaceId_initializers, _surfaceId_extraInitializers);
			__esDecorate$4(this, null, _surface_decorators, {
				kind: "accessor",
				name: "surface",
				static: false,
				private: false,
				access: {
					has: (obj) => "surface" in obj,
					get: (obj) => obj.surface,
					set: (obj, value) => {
						obj.surface = value;
					}
				},
				metadata: _metadata
			}, _surface_initializers, _surface_extraInitializers);
			__esDecorate$4(this, null, _processor_decorators, {
				kind: "accessor",
				name: "processor",
				static: false,
				private: false,
				access: {
					has: (obj) => "processor" in obj,
					get: (obj) => obj.processor,
					set: (obj, value) => {
						obj.processor = value;
					}
				},
				metadata: _metadata
			}, _processor_initializers, _processor_extraInitializers);
			__esDecorate$4(this, null, _enableCustomElements_decorators, {
				kind: "accessor",
				name: "enableCustomElements",
				static: false,
				private: false,
				access: {
					has: (obj) => "enableCustomElements" in obj,
					get: (obj) => obj.enableCustomElements,
					set: (obj, value) => {
						obj.enableCustomElements = value;
					}
				},
				metadata: _metadata
			}, _enableCustomElements_initializers, _enableCustomElements_extraInitializers);
			__esDecorate$4(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Surface = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#surfaceId_accessor_storage = __runInitializers$4(this, _surfaceId_initializers, null);
		get surfaceId() {
			return this.#surfaceId_accessor_storage;
		}
		set surfaceId(value) {
			this.#surfaceId_accessor_storage = value;
		}
		#surface_accessor_storage = (__runInitializers$4(this, _surfaceId_extraInitializers), __runInitializers$4(this, _surface_initializers, null));
		get surface() {
			return this.#surface_accessor_storage;
		}
		set surface(value) {
			this.#surface_accessor_storage = value;
		}
		#processor_accessor_storage = (__runInitializers$4(this, _surface_extraInitializers), __runInitializers$4(this, _processor_initializers, null));
		get processor() {
			return this.#processor_accessor_storage;
		}
		set processor(value) {
			this.#processor_accessor_storage = value;
		}
		static {
			this.styles = [i$10`
      :host {
        display: flex;
        min-height: 0;
        max-height: 100%;
        flex-direction: column;
        gap: 16px;
      }

      #surface-logo {
        display: flex;
        justify-content: center;

        & img {
          width: 50%;
          max-width: 220px;
        }
      }

      a2ui-root {
        flex: 1;
      }
    `];
		}
		#renderLogo() {
			if (!this.surface?.styles.logoUrl) return A;
			return b`<div id="surface-logo">
      <img src=${this.surface.styles.logoUrl} />
    </div>`;
		}
		#enableCustomElements_accessor_storage = (__runInitializers$4(this, _processor_extraInitializers), __runInitializers$4(this, _enableCustomElements_initializers, false));
		get enableCustomElements() {
			return this.#enableCustomElements_accessor_storage;
		}
		set enableCustomElements(value) {
			this.#enableCustomElements_accessor_storage = value;
		}
		#renderSurface() {
			const styles = {};
			if (this.surface?.styles) for (const [key, value] of Object.entries(this.surface.styles)) switch (key) {
				case "primaryColor":
					styles["--p-100"] = "#ffffff";
					styles["--p-99"] = `color-mix(in srgb, ${value} 2%, white 98%)`;
					styles["--p-98"] = `color-mix(in srgb, ${value} 4%, white 96%)`;
					styles["--p-95"] = `color-mix(in srgb, ${value} 10%, white 90%)`;
					styles["--p-90"] = `color-mix(in srgb, ${value} 20%, white 80%)`;
					styles["--p-80"] = `color-mix(in srgb, ${value} 40%, white 60%)`;
					styles["--p-70"] = `color-mix(in srgb, ${value} 60%, white 40%)`;
					styles["--p-60"] = `color-mix(in srgb, ${value} 80%, white 20%)`;
					styles["--p-50"] = value;
					styles["--p-40"] = `color-mix(in srgb, ${value} 80%, black 20%)`;
					styles["--p-35"] = `color-mix(in srgb, ${value} 70%, black 30%)`;
					styles["--p-30"] = `color-mix(in srgb, ${value} 60%, black 40%)`;
					styles["--p-25"] = `color-mix(in srgb, ${value} 50%, black 50%)`;
					styles["--p-20"] = `color-mix(in srgb, ${value} 40%, black 60%)`;
					styles["--p-15"] = `color-mix(in srgb, ${value} 30%, black 70%)`;
					styles["--p-10"] = `color-mix(in srgb, ${value} 20%, black 80%)`;
					styles["--p-5"] = `color-mix(in srgb, ${value} 10%, black 90%)`;
					styles["--0"] = "#00000";
					break;
				case "font":
					styles["--font-family"] = value;
					styles["--font-family-flex"] = value;
					break;
			}
			return b`<a2ui-root
      style=${o$2(styles)}
      .surfaceId=${this.surfaceId}
      .processor=${this.processor}
      .childComponents=${this.surface?.componentTree ? [this.surface.componentTree] : null}
      .enableCustomElements=${this.enableCustomElements}
    ></a2ui-root>`;
		}
		render() {
			if (!this.surface) return A;
			return b`${[this.#renderLogo(), this.#renderSurface()]}`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$4(this, _enableCustomElements_extraInitializers);
		}
		static {
			__runInitializers$4(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
const u = (e, s, t) => {
	const r = /* @__PURE__ */ new Map();
	for (let l = s; l <= t; l++) r.set(e[l], l);
	return r;
}, c$1 = e$6(class extends i$5 {
	constructor(e) {
		if (super(e), e.type !== t$3.CHILD) throw Error("repeat() can only be used in text expressions");
	}
	dt(e, s, t) {
		let r;
		void 0 === t ? t = s : void 0 !== s && (r = s);
		const l = [], o = [];
		let i = 0;
		for (const s of e) l[i] = r ? r(s, i) : i, o[i] = t(s, i), i++;
		return {
			values: o,
			keys: l
		};
	}
	render(e, s, t) {
		return this.dt(e, s, t).values;
	}
	update(s, [t, r, c]) {
		const d = M(s), { values: p$3, keys: a } = this.dt(t, r, c);
		if (!Array.isArray(d)) return this.ut = a, p$3;
		const h = this.ut ??= [], v$2 = [];
		let m, y, x = 0, j = d.length - 1, k = 0, w = p$3.length - 1;
		for (; x <= j && k <= w;) if (null === d[x]) x++;
		else if (null === d[j]) j--;
		else if (h[x] === a[k]) v$2[k] = u$1(d[x], p$3[k]), x++, k++;
		else if (h[j] === a[w]) v$2[w] = u$1(d[j], p$3[w]), j--, w--;
		else if (h[x] === a[w]) v$2[w] = u$1(d[x], p$3[w]), v(s, v$2[w + 1], d[x]), x++, w--;
		else if (h[j] === a[k]) v$2[k] = u$1(d[j], p$3[k]), v(s, d[x], d[j]), j--, k++;
		else if (void 0 === m && (m = u(a, k, w), y = u(h, x, j)), m.has(h[x])) if (m.has(h[j])) {
			const e = y.get(a[k]), t = void 0 !== e ? d[e] : null;
			if (null === t) {
				const e = v(s, d[x]);
				u$1(e, p$3[k]), v$2[k] = e;
			} else v$2[k] = u$1(t, p$3[k]), v(s, d[x], t), d[e] = null;
			k++;
		} else h$4(d[j]), j--;
		else h$4(d[x]), x++;
		for (; k <= w;) {
			const e = v(s, v$2[w + 1]);
			u$1(e, p$3[k]), v$2[k++] = e;
		}
		for (; x <= j;) {
			const e = d[x++];
			null !== e && h$4(e);
		}
		return this.ut = a, p(s, v$2), E;
	}
});
var __esDecorate$3 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$3 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-tabs")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _titles_decorators;
	let _titles_initializers = [];
	let _titles_extraInitializers = [];
	let _selected_decorators;
	let _selected_initializers = [];
	let _selected_extraInitializers = [];
	var Tabs = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_titles_decorators = [n$9()];
			_selected_decorators = [n$9()];
			__esDecorate$3(this, null, _titles_decorators, {
				kind: "accessor",
				name: "titles",
				static: false,
				private: false,
				access: {
					has: (obj) => "titles" in obj,
					get: (obj) => obj.titles,
					set: (obj, value) => {
						obj.titles = value;
					}
				},
				metadata: _metadata
			}, _titles_initializers, _titles_extraInitializers);
			__esDecorate$3(this, null, _selected_decorators, {
				kind: "accessor",
				name: "selected",
				static: false,
				private: false,
				access: {
					has: (obj) => "selected" in obj,
					get: (obj) => obj.selected,
					set: (obj, value) => {
						obj.selected = value;
					}
				},
				metadata: _metadata
			}, _selected_initializers, _selected_extraInitializers);
			__esDecorate$3(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Tabs = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#titles_accessor_storage = __runInitializers$3(this, _titles_initializers, null);
		get titles() {
			return this.#titles_accessor_storage;
		}
		set titles(value) {
			this.#titles_accessor_storage = value;
		}
		#selected_accessor_storage = (__runInitializers$3(this, _titles_extraInitializers), __runInitializers$3(this, _selected_initializers, 0));
		get selected() {
			return this.#selected_accessor_storage;
		}
		set selected(value) {
			this.#selected_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$10`
      :host {
        display: block;
        flex: var(--weight);
      }
    `];
		}
		willUpdate(changedProperties) {
			super.willUpdate(changedProperties);
			if (changedProperties.has("selected")) {
				for (const child of this.children) child.removeAttribute("slot");
				const selectedChild = this.children[this.selected];
				if (!selectedChild) return;
				selectedChild.slot = "current";
			}
		}
		#renderTabs() {
			if (!this.titles) return A;
			return b`<div id="buttons" class=${e$2(this.theme.components.Tabs.element)}>
      ${c$1(this.titles, (title, idx) => {
				let titleString = "";
				if ("literalString" in title && title.literalString) titleString = title.literalString;
				else if ("literal" in title && title.literal !== void 0) titleString = title.literal;
				else if (title && "path" in title && title.path) {
					if (!this.processor || !this.component) return b`(no model)`;
					const textValue = this.processor.getData(this.component, title.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (typeof textValue !== "string") return b`(invalid)`;
					titleString = textValue;
				}
				let classes;
				if (this.selected === idx) classes = merge(this.theme.components.Tabs.controls.all, this.theme.components.Tabs.controls.selected);
				else classes = { ...this.theme.components.Tabs.controls.all };
				return b`<button
          ?disabled=${this.selected === idx}
          class=${e$2(classes)}
          @click=${() => {
					this.selected = idx;
				}}
        >
          ${titleString}
        </button>`;
			})}
    </div>`;
		}
		#renderSlot() {
			return b`<slot name="current"></slot>`;
		}
		render() {
			return b`<section
      class=${e$2(this.theme.components.Tabs.container)}
      style=${this.theme.additionalStyles?.Tabs ? o$2(this.theme.additionalStyles?.Tabs) : A}
    >
      ${[this.#renderTabs(), this.#renderSlot()]}
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$3(this, _selected_extraInitializers);
		}
		static {
			__runInitializers$3(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$2 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$2 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-textfield")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _text_decorators;
	let _text_initializers = [];
	let _text_extraInitializers = [];
	let _label_decorators;
	let _label_initializers = [];
	let _label_extraInitializers = [];
	let _textFieldType_decorators;
	let _textFieldType_initializers = [];
	let _textFieldType_extraInitializers = [];
	let _validationRegexp_decorators;
	let _validationRegexp_initializers = [];
	let _validationRegexp_extraInitializers = [];
	var TextField = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_text_decorators = [n$9()];
			_label_decorators = [n$9()];
			_textFieldType_decorators = [n$9()];
			_validationRegexp_decorators = [n$9()];
			__esDecorate$2(this, null, _text_decorators, {
				kind: "accessor",
				name: "text",
				static: false,
				private: false,
				access: {
					has: (obj) => "text" in obj,
					get: (obj) => obj.text,
					set: (obj, value) => {
						obj.text = value;
					}
				},
				metadata: _metadata
			}, _text_initializers, _text_extraInitializers);
			__esDecorate$2(this, null, _label_decorators, {
				kind: "accessor",
				name: "label",
				static: false,
				private: false,
				access: {
					has: (obj) => "label" in obj,
					get: (obj) => obj.label,
					set: (obj, value) => {
						obj.label = value;
					}
				},
				metadata: _metadata
			}, _label_initializers, _label_extraInitializers);
			__esDecorate$2(this, null, _textFieldType_decorators, {
				kind: "accessor",
				name: "textFieldType",
				static: false,
				private: false,
				access: {
					has: (obj) => "textFieldType" in obj,
					get: (obj) => obj.textFieldType,
					set: (obj, value) => {
						obj.textFieldType = value;
					}
				},
				metadata: _metadata
			}, _textFieldType_initializers, _textFieldType_extraInitializers);
			__esDecorate$2(this, null, _validationRegexp_decorators, {
				kind: "accessor",
				name: "validationRegexp",
				static: false,
				private: false,
				access: {
					has: (obj) => "validationRegexp" in obj,
					get: (obj) => obj.validationRegexp,
					set: (obj, value) => {
						obj.validationRegexp = value;
					}
				},
				metadata: _metadata
			}, _validationRegexp_initializers, _validationRegexp_extraInitializers);
			__esDecorate$2(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			TextField = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#text_accessor_storage = __runInitializers$2(this, _text_initializers, null);
		get text() {
			return this.#text_accessor_storage;
		}
		set text(value) {
			this.#text_accessor_storage = value;
		}
		#label_accessor_storage = (__runInitializers$2(this, _text_extraInitializers), __runInitializers$2(this, _label_initializers, null));
		get label() {
			return this.#label_accessor_storage;
		}
		set label(value) {
			this.#label_accessor_storage = value;
		}
		#textFieldType_accessor_storage = (__runInitializers$2(this, _label_extraInitializers), __runInitializers$2(this, _textFieldType_initializers, null));
		get textFieldType() {
			return this.#textFieldType_accessor_storage;
		}
		set textFieldType(value) {
			this.#textFieldType_accessor_storage = value;
		}
		#validationRegexp_accessor_storage = (__runInitializers$2(this, _textFieldType_extraInitializers), __runInitializers$2(this, _validationRegexp_initializers, null));
		get validationRegexp() {
			return this.#validationRegexp_accessor_storage;
		}
		set validationRegexp(value) {
			this.#validationRegexp_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$10`
      * {
        box-sizing: border-box;
      }

      :host {
        display: flex;
        flex: var(--weight);
      }

      input {
        display: block;
        width: 100%;
      }

      input:invalid {
        border-color: var(--color-error);
        color: var(--color-error);
        outline-color: var(--color-error);
      }

      input:invalid:focus {
        border-color: var(--color-error);
        outline-color: var(--color-error);
      }

      label {
        display: block;
        margin-bottom: 4px;
      }
    `];
		}
		#setBoundValue(value) {
			if (!this.text || !this.processor) return;
			if (!("path" in this.text)) return;
			if (!this.text.path) return;
			this.processor.setData(this.component, this.text.path, value, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
		}
		#renderField(value, label) {
			return b` <section class=${e$2(this.theme.components.TextField.container)}>
      ${label && label !== "" ? b`<label class=${e$2(this.theme.components.TextField.label)} for="data"
            >${label}</label
          >` : A}
      <input
        autocomplete="off"
        class=${e$2(this.theme.components.TextField.element)}
        style=${this.theme.additionalStyles?.TextField ? o$2(this.theme.additionalStyles?.TextField) : A}
        @input=${(evt) => {
				if (!(evt.target instanceof HTMLInputElement)) return;
				this.dispatchEvent(new A2UIValidationEvent({
					componentId: this.id,
					value: evt.target.value,
					valid: evt.target.checkValidity()
				}));
				this.#setBoundValue(evt.target.value);
			}}
        name="data"
        id="data"
        .value=${value}
        .placeholder=${"Please enter a value"}
        pattern=${this.validationRegexp || A}
        type=${this.textFieldType === "number" ? "number" : "text"}
      />
    </section>`;
		}
		render() {
			const label = extractStringValue(this.label, this.component, this.processor, this.surfaceId);
			const value = extractStringValue(this.text, this.component, this.processor, this.surfaceId);
			return this.#renderField(value, label);
		}
		constructor() {
			super(...arguments);
			__runInitializers$2(this, _validationRegexp_extraInitializers);
		}
		static {
			__runInitializers$2(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ var e = class extends i$5 {
	constructor(i) {
		if (super(i), this.it = A, i.type !== t$3.CHILD) throw Error(this.constructor.directiveName + "() can only be used in child bindings");
	}
	render(r) {
		if (r === A || null == r) return this._t = void 0, this.it = r;
		if (r === E) return r;
		if ("string" != typeof r) throw Error(this.constructor.directiveName + "() called with a non-string value");
		if (r === this.it) return this._t;
		this.it = r;
		const s = [r];
		return s.raw = s, this._t = {
			_$litType$: this.constructor.resultType,
			strings: s,
			values: []
		};
	}
};
e.directiveName = "unsafeHTML", e.resultType = 1;
const o = e$6(e);
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
var s = class {
	constructor(t) {
		this.G = t;
	}
	disconnect() {
		this.G = void 0;
	}
	reconnect(t) {
		this.G = t;
	}
	deref() {
		return this.G;
	}
};
var i = class {
	constructor() {
		this.Y = void 0, this.Z = void 0;
	}
	get() {
		return this.Y;
	}
	pause() {
		this.Y ??= new Promise((t) => this.Z = t);
	}
	resume() {
		this.Z?.(), this.Y = this.Z = void 0;
	}
};
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ const n = (t) => !n$6(t) && "function" == typeof t.then, h = 1073741823;
var c = class extends f {
	constructor() {
		super(...arguments), this._$Cwt = h, this._$Cbt = [], this._$CK = new s(this), this._$CX = new i();
	}
	render(...s) {
		return s.find((t) => !n(t)) ?? E;
	}
	update(s, i) {
		const e = this._$Cbt;
		let r = e.length;
		this._$Cbt = i;
		const o = this._$CK, c = this._$CX;
		this.isConnected || this.disconnected();
		for (let t = 0; t < i.length && !(t > this._$Cwt); t++) {
			const s = i[t];
			if (!n(s)) return this._$Cwt = t, s;
			t < r && s === e[t] || (this._$Cwt = h, r = 0, Promise.resolve(s).then(async (t) => {
				for (; c.get();) await c.get();
				const i = o.deref();
				if (void 0 !== i) {
					const e = i._$Cbt.indexOf(s);
					e > -1 && e < i._$Cwt && (i._$Cwt = e, i.setValue(t));
				}
			}));
		}
		return E;
	}
	disconnected() {
		this._$CK.disconnect(), this._$CX.pause();
	}
	reconnected() {
		this._$CK.reconnect(this), this._$CX.resume();
	}
};
const m = e$6(c);
const markdown$1 = e$6(class MarkdownDirective extends i$5 {
	#lastValue = null;
	#lastTagClassMap = null;
	update(_part, [value, markdownRenderer, markdownOptions]) {
		const jsonTagClassMap = JSON.stringify(markdownOptions?.tagClassMap);
		if (this.#lastValue === value && jsonTagClassMap === this.#lastTagClassMap) return E;
		this.#lastValue = value;
		this.#lastTagClassMap = jsonTagClassMap;
		return this.render(value, markdownRenderer, markdownOptions);
	}
	static {
		this.defaultMarkdownWarningLogged = false;
	}
	/**
	* Renders the markdown string to HTML using the injected markdown renderer,
	* if present. Otherwise, it returns the value wrapped in a span.
	*/
	render(value, markdownRenderer, markdownOptions) {
		if (markdownRenderer) return m(markdownRenderer(value, markdownOptions).then((value) => {
			return o(value);
		}), b`<span class="no-markdown-renderer">${value}</span>`);
		return m((async () => {
			try {
				const { renderMarkdown } = await import("@a2ui/markdown-it");
				return o(await renderMarkdown(value, markdownOptions));
			} catch (e) {
				if (!MarkdownDirective.defaultMarkdownWarningLogged) {
					console.warn("[MarkdownDirective] Failed to load optional `@a2ui/markdown-it` renderer. Using fallback regex.");
					MarkdownDirective.defaultMarkdownWarningLogged = true;
				}
				return b`<span class="no-markdown-renderer">${value}</span>`;
			}
		})(), b`<span class="no-markdown-renderer">${value}</span>`);
	}
});
/**
* The markdown renderer context.
*/
const markdown = n$3(Symbol("A2UIMarkdown"));
var __esDecorate$1 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$1 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-text")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _text_decorators;
	let _text_initializers = [];
	let _text_extraInitializers = [];
	let _usageHint_decorators;
	let _usageHint_initializers = [];
	let _usageHint_extraInitializers = [];
	let _markdownRenderer_decorators;
	let _markdownRenderer_initializers = [];
	let _markdownRenderer_extraInitializers = [];
	var Text = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_text_decorators = [n$9()];
			_usageHint_decorators = [n$9({
				reflect: true,
				attribute: "usage-hint"
			})];
			_markdownRenderer_decorators = [c$2({ context: markdown })];
			__esDecorate$1(this, null, _text_decorators, {
				kind: "accessor",
				name: "text",
				static: false,
				private: false,
				access: {
					has: (obj) => "text" in obj,
					get: (obj) => obj.text,
					set: (obj, value) => {
						obj.text = value;
					}
				},
				metadata: _metadata
			}, _text_initializers, _text_extraInitializers);
			__esDecorate$1(this, null, _usageHint_decorators, {
				kind: "accessor",
				name: "usageHint",
				static: false,
				private: false,
				access: {
					has: (obj) => "usageHint" in obj,
					get: (obj) => obj.usageHint,
					set: (obj, value) => {
						obj.usageHint = value;
					}
				},
				metadata: _metadata
			}, _usageHint_initializers, _usageHint_extraInitializers);
			__esDecorate$1(this, null, _markdownRenderer_decorators, {
				kind: "accessor",
				name: "markdownRenderer",
				static: false,
				private: false,
				access: {
					has: (obj) => "markdownRenderer" in obj,
					get: (obj) => obj.markdownRenderer,
					set: (obj, value) => {
						obj.markdownRenderer = value;
					}
				},
				metadata: _metadata
			}, _markdownRenderer_initializers, _markdownRenderer_extraInitializers);
			__esDecorate$1(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Text = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#text_accessor_storage = __runInitializers$1(this, _text_initializers, null);
		get text() {
			return this.#text_accessor_storage;
		}
		set text(value) {
			this.#text_accessor_storage = value;
		}
		#usageHint_accessor_storage = (__runInitializers$1(this, _text_extraInitializers), __runInitializers$1(this, _usageHint_initializers, null));
		get usageHint() {
			return this.#usageHint_accessor_storage;
		}
		set usageHint(value) {
			this.#usageHint_accessor_storage = value;
		}
		#markdownRenderer_accessor_storage = (__runInitializers$1(this, _usageHint_extraInitializers), __runInitializers$1(this, _markdownRenderer_initializers, void 0));
		get markdownRenderer() {
			return this.#markdownRenderer_accessor_storage;
		}
		set markdownRenderer(value) {
			this.#markdownRenderer_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$10`
      :host {
        display: block;
        flex: var(--weight);
      }

      h1,
      h2,
      h3,
      h4,
      h5 {
        line-height: inherit;
        font: inherit;
      }
    `];
		}
		#renderText() {
			let textValue = null;
			if (this.text && typeof this.text === "object") {
				if ("literalString" in this.text && this.text.literalString) textValue = this.text.literalString;
				else if ("literal" in this.text && this.text.literal !== void 0) textValue = this.text.literal;
				else if (this.text && "path" in this.text && this.text.path) {
					if (!this.processor || !this.component) return b`(no model)`;
					const value = this.processor.getData(this.component, this.text.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (value !== null && value !== void 0) textValue = value.toString();
				}
			}
			if (textValue === null || textValue === void 0) return b`(empty)`;
			let markdownText = textValue;
			switch (this.usageHint) {
				case "h1":
					markdownText = `# ${markdownText}`;
					break;
				case "h2":
					markdownText = `## ${markdownText}`;
					break;
				case "h3":
					markdownText = `### ${markdownText}`;
					break;
				case "h4":
					markdownText = `#### ${markdownText}`;
					break;
				case "h5":
					markdownText = `##### ${markdownText}`;
					break;
				case "caption":
					markdownText = `*${markdownText}*`;
					break;
				default: break;
			}
			return b`${markdown$1(markdownText, this.markdownRenderer, { tagClassMap: appendToAll(this.theme.markdown, [
				"ol",
				"ul",
				"li"
			], {}) })}`;
		}
		#areHintedStyles(styles) {
			if (typeof styles !== "object") return false;
			if (Array.isArray(styles)) return false;
			if (!styles) return false;
			return [
				"h1",
				"h2",
				"h3",
				"h4",
				"h5",
				"h6",
				"caption",
				"body"
			].every((v) => v in styles);
		}
		#getAdditionalStyles() {
			let additionalStyles = {};
			const styles = this.theme.additionalStyles?.Text;
			if (!styles) return additionalStyles;
			if (this.#areHintedStyles(styles)) additionalStyles = styles[this.usageHint ?? "body"];
			else additionalStyles = styles;
			return additionalStyles;
		}
		render() {
			return b`<section
      class=${e$2(merge(this.theme.components.Text.all, this.usageHint ? this.theme.components.Text[this.usageHint] : {}))}
      style=${this.theme.additionalStyles?.Text ? o$2(this.#getAdditionalStyles()) : A}
    >
      ${this.#renderText()}
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$1(this, _markdownRenderer_extraInitializers);
		}
		static {
			__runInitializers$1(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$5("a2ui-video")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _url_decorators;
	let _url_initializers = [];
	let _url_extraInitializers = [];
	var Video = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_url_decorators = [n$9()];
			__esDecorate(this, null, _url_decorators, {
				kind: "accessor",
				name: "url",
				static: false,
				private: false,
				access: {
					has: (obj) => "url" in obj,
					get: (obj) => obj.url,
					set: (obj, value) => {
						obj.url = value;
					}
				},
				metadata: _metadata
			}, _url_initializers, _url_extraInitializers);
			__esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Video = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#url_accessor_storage = __runInitializers(this, _url_initializers, null);
		get url() {
			return this.#url_accessor_storage;
		}
		set url(value) {
			this.#url_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$10`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      video {
        display: block;
        width: 100%;
      }
    `];
		}
		#renderVideo() {
			if (!this.url) return A;
			if (this.url && typeof this.url === "object") {
				if ("literalString" in this.url) return b`<video controls src=${this.url.literalString} />`;
				else if ("literal" in this.url) return b`<video controls src=${this.url.literal} />`;
				else if (this.url && "path" in this.url && this.url.path) {
					if (!this.processor || !this.component) return b`(no processor)`;
					const videoUrl = this.processor.getData(this.component, this.url.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (!videoUrl) return b`Invalid video URL`;
					if (typeof videoUrl !== "string") return b`Invalid video URL`;
					return b`<video controls src=${videoUrl} />`;
				}
			}
			return b`(empty)`;
		}
		render() {
			return b`<section
      class=${e$2(this.theme.components.Video)}
      style=${this.theme.additionalStyles?.Video ? o$2(this.theme.additionalStyles?.Video) : A}
    >
      ${this.#renderVideo()}
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers(this, _url_extraInitializers);
		}
		static {
			__runInitializers(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
const modalStyles = i$10`
  dialog {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 24px;
    border: none;
    background: rgba(5, 8, 16, 0.65);
    backdrop-filter: blur(6px);
    display: grid;
    place-items: center;
  }

  dialog::backdrop {
    background: rgba(5, 8, 16, 0.65);
    backdrop-filter: blur(6px);
  }
`;
const modalElement = customElements.get("a2ui-modal");
if (modalElement && Array.isArray(modalElement.styles)) modalElement.styles = [...modalElement.styles, modalStyles];
const appendComponentStyles = (tagName, extraStyles) => {
	const component = customElements.get(tagName);
	if (!component) return;
	const current = component.styles;
	if (!current) {
		component.styles = [extraStyles];
		return;
	}
	component.styles = Array.isArray(current) ? [...current, extraStyles] : [current, extraStyles];
};
appendComponentStyles("a2ui-row", i$10`
    @media (max-width: 860px) {
      section {
        flex-wrap: wrap;
        align-content: flex-start;
      }

      ::slotted(*) {
        flex: 1 1 100%;
        min-width: 100%;
        width: 100%;
        max-width: 100%;
      }
    }
  `);
appendComponentStyles("a2ui-column", i$10`
    :host {
      min-width: 0;
    }

    section {
      min-width: 0;
    }
  `);
appendComponentStyles("a2ui-card", i$10`
    :host {
      min-width: 0;
    }

    section {
      min-width: 0;
    }
  `);
const emptyClasses = () => ({});
const textHintStyles = () => ({
	h1: {},
	h2: {},
	h3: {},
	h4: {},
	h5: {},
	body: {},
	caption: {}
});
const isAndroid = /Android/i.test(globalThis.navigator?.userAgent ?? "");
const cardShadow = isAndroid ? "0 2px 10px rgba(0,0,0,.18)" : "0 10px 30px rgba(0,0,0,.35)";
const buttonShadow = isAndroid ? "0 2px 10px rgba(6, 182, 212, 0.14)" : "0 10px 25px rgba(6, 182, 212, 0.18)";
const statusShadow = isAndroid ? "0 2px 10px rgba(0, 0, 0, 0.18)" : "0 10px 24px rgba(0, 0, 0, 0.25)";
const statusBlur = isAndroid ? "10px" : "14px";
const postNativeMessage = (handler, payload) => {
	Reflect.apply(handler.postMessage, handler, [payload]);
};
const openclawTheme = {
	components: {
		AudioPlayer: emptyClasses(),
		Button: emptyClasses(),
		Card: emptyClasses(),
		Column: emptyClasses(),
		CheckBox: {
			container: emptyClasses(),
			element: emptyClasses(),
			label: emptyClasses()
		},
		DateTimeInput: {
			container: emptyClasses(),
			element: emptyClasses(),
			label: emptyClasses()
		},
		Divider: emptyClasses(),
		Image: {
			all: emptyClasses(),
			icon: emptyClasses(),
			avatar: emptyClasses(),
			smallFeature: emptyClasses(),
			mediumFeature: emptyClasses(),
			largeFeature: emptyClasses(),
			header: emptyClasses()
		},
		Icon: emptyClasses(),
		List: emptyClasses(),
		Modal: {
			backdrop: emptyClasses(),
			element: emptyClasses()
		},
		MultipleChoice: {
			container: emptyClasses(),
			element: emptyClasses(),
			label: emptyClasses()
		},
		Row: emptyClasses(),
		Slider: {
			container: emptyClasses(),
			element: emptyClasses(),
			label: emptyClasses()
		},
		Tabs: {
			container: emptyClasses(),
			element: emptyClasses(),
			controls: {
				all: emptyClasses(),
				selected: emptyClasses()
			}
		},
		Text: {
			all: emptyClasses(),
			h1: emptyClasses(),
			h2: emptyClasses(),
			h3: emptyClasses(),
			h4: emptyClasses(),
			h5: emptyClasses(),
			caption: emptyClasses(),
			body: emptyClasses()
		},
		TextField: {
			container: emptyClasses(),
			element: emptyClasses(),
			label: emptyClasses()
		},
		Video: emptyClasses()
	},
	elements: {
		a: emptyClasses(),
		audio: emptyClasses(),
		body: emptyClasses(),
		button: emptyClasses(),
		h1: emptyClasses(),
		h2: emptyClasses(),
		h3: emptyClasses(),
		h4: emptyClasses(),
		h5: emptyClasses(),
		iframe: emptyClasses(),
		input: emptyClasses(),
		p: emptyClasses(),
		pre: emptyClasses(),
		textarea: emptyClasses(),
		video: emptyClasses()
	},
	markdown: {
		p: [],
		h1: [],
		h2: [],
		h3: [],
		h4: [],
		h5: [],
		ul: [],
		ol: [],
		li: [],
		a: [],
		strong: [],
		em: []
	},
	additionalStyles: {
		Card: {
			background: "linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03))",
			border: "1px solid rgba(255,255,255,.09)",
			borderRadius: "14px",
			padding: "14px",
			boxShadow: cardShadow
		},
		Modal: {
			background: "rgba(12, 16, 24, 0.92)",
			border: "1px solid rgba(255,255,255,.12)",
			borderRadius: "16px",
			padding: "16px",
			boxShadow: "0 30px 80px rgba(0,0,0,.6)",
			width: "min(520px, calc(100vw - 48px))"
		},
		Column: { gap: "10px" },
		Row: {
			gap: "10px",
			alignItems: "center"
		},
		Divider: { opacity: "0.25" },
		Button: {
			background: "linear-gradient(135deg, #22c55e 0%, #06b6d4 100%)",
			border: "0",
			borderRadius: "12px",
			padding: "10px 14px",
			color: "#071016",
			fontWeight: "650",
			cursor: "pointer",
			boxShadow: buttonShadow
		},
		Text: {
			...textHintStyles(),
			h1: {
				fontSize: "20px",
				fontWeight: "750",
				margin: "0 0 6px 0"
			},
			h2: {
				fontSize: "16px",
				fontWeight: "700",
				margin: "0 0 6px 0"
			},
			body: {
				fontSize: "13px",
				lineHeight: "1.4"
			},
			caption: { opacity: "0.8" }
		},
		TextField: {
			display: "grid",
			gap: "6px"
		},
		Image: { borderRadius: "12px" }
	}
};
var OpenClawA2UIHost = class extends i$7 {
	static properties = {
		surfaces: { state: true },
		pendingAction: { state: true },
		toast: { state: true }
	};
	#processor = Data.createSignalA2uiMessageProcessor();
	themeProvider = new i$2(this, {
		context: themeContext,
		initialValue: openclawTheme
	});
	surfaces = [];
	pendingAction = null;
	toast = null;
	#statusListener = null;
	static styles = i$10`
    :host {
      display: block;
      height: 100%;
      position: relative;
      box-sizing: border-box;
      padding: var(--openclaw-a2ui-inset-top, 0px) var(--openclaw-a2ui-inset-right, 0px)
        var(--openclaw-a2ui-inset-bottom, 0px) var(--openclaw-a2ui-inset-left, 0px);
    }

    #surfaces {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
      height: 100%;
      overflow: auto;
      padding-bottom: var(--openclaw-a2ui-scroll-pad-bottom, 0px);
    }

    .status {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      top: var(--openclaw-a2ui-status-top, 12px);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: rgba(255, 255, 255, 0.92);
      font:
        13px/1.2 system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Roboto",
        sans-serif;
      pointer-events: none;
      backdrop-filter: blur(${r$11(statusBlur)});
      -webkit-backdrop-filter: blur(${r$11(statusBlur)});
      box-shadow: ${r$11(statusShadow)};
      z-index: 5;
    }

    .toast {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      bottom: var(--openclaw-a2ui-toast-bottom, 12px);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: rgba(255, 255, 255, 0.92);
      font:
        13px/1.2 system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Roboto",
        sans-serif;
      pointer-events: none;
      backdrop-filter: blur(${r$11(statusBlur)});
      -webkit-backdrop-filter: blur(${r$11(statusBlur)});
      box-shadow: ${r$11(statusShadow)};
      z-index: 5;
    }

    .toast.error {
      border-color: rgba(255, 109, 109, 0.35);
      color: rgba(255, 223, 223, 0.98);
    }

    .empty {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      top: var(--openclaw-a2ui-empty-top, var(--openclaw-a2ui-status-top, 12px));
      text-align: center;
      opacity: 0.8;
      padding: 10px 12px;
      pointer-events: none;
    }

    .empty-title {
      font-weight: 700;
      margin-bottom: 6px;
    }

    .spinner {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      border: 2px solid rgba(255, 255, 255, 0.25);
      border-top-color: rgba(255, 255, 255, 0.92);
      animation: spin 0.75s linear infinite;
    }

    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  `;
	connectedCallback() {
		super.connectedCallback();
		globalThis.openclawA2UI = {
			applyMessages: (messages) => this.applyMessages(messages),
			reset: () => this.reset(),
			getSurfaces: () => Array.from(this.#processor.getSurfaces().keys())
		};
		this.addEventListener("a2uiaction", (evt) => this.#handleA2UIAction(evt));
		this.#statusListener = (evt) => this.#handleActionStatus(evt);
		for (const eventName of ["openclaw:a2ui-action-status"]) globalThis.addEventListener(eventName, this.#statusListener);
		this.#syncSurfaces();
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		if (this.#statusListener) {
			for (const eventName of ["openclaw:a2ui-action-status"]) globalThis.removeEventListener(eventName, this.#statusListener);
			this.#statusListener = null;
		}
	}
	#makeActionId() {
		return globalThis.crypto?.randomUUID?.() ?? `a2ui_${Date.now()}_${Math.random().toString(16).slice(2)}`;
	}
	#setToast(text, kind = "ok", timeoutMs = 1400) {
		const toast = {
			text,
			kind,
			expiresAt: Date.now() + timeoutMs
		};
		this.toast = toast;
		this.requestUpdate();
		setTimeout(() => {
			if (this.toast === toast) {
				this.toast = null;
				this.requestUpdate();
			}
		}, timeoutMs + 30);
	}
	#handleActionStatus(evt) {
		const detail = evt?.detail ?? null;
		if (!detail || typeof detail.id !== "string") return;
		if (!this.pendingAction || this.pendingAction.id !== detail.id) return;
		if (detail.ok) this.pendingAction = {
			...this.pendingAction,
			phase: "sent",
			sentAt: Date.now()
		};
		else {
			const msg = typeof detail.error === "string" && detail.error ? detail.error : "send failed";
			this.pendingAction = {
				...this.pendingAction,
				phase: "error",
				error: msg
			};
			this.#setToast(`Failed: ${msg}`, "error", 4500);
		}
		this.requestUpdate();
	}
	#handleA2UIAction(evt) {
		const payload = evt?.detail ?? evt?.payload ?? null;
		if (!payload || payload.eventType !== "a2ui.action") return;
		const action = payload.action;
		const name = action?.name;
		if (!name) return;
		const sourceComponentId = payload.sourceComponentId ?? "";
		const surfaces = this.#processor.getSurfaces();
		let surfaceId = null;
		let sourceNode = null;
		for (const [sid, surface] of surfaces.entries()) {
			const node = surface?.components?.get?.(sourceComponentId) ?? null;
			if (node) {
				surfaceId = sid;
				sourceNode = node;
				break;
			}
		}
		const context = {};
		const ctxItems = Array.isArray(action?.context) ? action.context : [];
		for (const item of ctxItems) {
			const key = item?.key;
			const value = item?.value ?? null;
			if (!key || !value) continue;
			if (typeof value.path === "string") {
				context[key] = sourceNode ? this.#processor.getData(sourceNode, value.path, surfaceId ?? void 0) : null;
				continue;
			}
			if (Object.hasOwn(value, "literalString")) {
				context[key] = value.literalString ?? "";
				continue;
			}
			if (Object.hasOwn(value, "literalNumber")) {
				context[key] = value.literalNumber ?? 0;
				continue;
			}
			if (Object.hasOwn(value, "literalBoolean")) {
				context[key] = value.literalBoolean ?? false;
				continue;
			}
		}
		const actionId = this.#makeActionId();
		this.pendingAction = {
			id: actionId,
			name,
			phase: "sending",
			startedAt: Date.now()
		};
		this.requestUpdate();
		const userAction = {
			id: actionId,
			name,
			surfaceId: surfaceId ?? "main",
			sourceComponentId,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			...Object.keys(context).length ? { context } : {}
		};
		globalThis["__openclawLastA2UIAction"] = userAction;
		const handler = globalThis.webkit?.messageHandlers?.openclawCanvasA2UIAction ?? globalThis.openclawCanvasA2UIAction;
		if (handler?.postMessage) try {
			if (handler === globalThis.openclawCanvasA2UIAction) postNativeMessage(handler, JSON.stringify({ userAction }));
			else postNativeMessage(handler, { userAction });
		} catch (e) {
			const msg = String(e?.message ?? e);
			this.pendingAction = {
				id: actionId,
				name,
				phase: "error",
				startedAt: Date.now(),
				error: msg
			};
			this.#setToast(`Failed: ${msg}`, "error", 4500);
		}
		else {
			this.pendingAction = {
				id: actionId,
				name,
				phase: "error",
				startedAt: Date.now(),
				error: "missing native bridge"
			};
			this.#setToast("Failed: missing native bridge", "error", 4500);
		}
	}
	applyMessages(messages) {
		if (!Array.isArray(messages)) throw new Error("A2UI: expected messages array");
		this.#processor.processMessages(messages);
		this.#syncSurfaces();
		if (this.pendingAction?.phase === "sent") {
			this.#setToast(`Updated: ${this.pendingAction.name}`, "ok", 1100);
			this.pendingAction = null;
		}
		this.requestUpdate();
		return {
			ok: true,
			surfaces: this.surfaces.map(([id]) => id)
		};
	}
	reset() {
		this.#processor.clearSurfaces();
		this.#syncSurfaces();
		this.pendingAction = null;
		this.requestUpdate();
		return { ok: true };
	}
	#syncSurfaces() {
		this.surfaces = Array.from(this.#processor.getSurfaces().entries());
	}
	render() {
		if (this.surfaces.length === 0) return b`<div class="empty">
        <div class="empty-title">Canvas (A2UI)</div>
      </div>`;
		const statusText = this.pendingAction?.phase === "sent" ? `Working: ${this.pendingAction.name}` : this.pendingAction?.phase === "sending" ? `Sending: ${this.pendingAction.name}` : this.pendingAction?.phase === "error" ? `Failed: ${this.pendingAction.name}` : "";
		return b` ${this.pendingAction && this.pendingAction.phase !== "error" ? b`<div class="status">
            <div class="spinner"></div>
            <div>${statusText}</div>
          </div>` : ""}
      ${this.toast ? b`<div class="toast ${this.toast.kind === "error" ? "error" : ""}">
            ${this.toast.text}
          </div>` : ""}
      <section id="surfaces">
        ${c$1(this.surfaces, ([surfaceId]) => surfaceId, ([surfaceId, surface]) => b`<a2ui-surface
            .surfaceId=${surfaceId}
            .surface=${surface}
            .processor=${this.#processor}
          ></a2ui-surface>`)}
      </section>`;
	}
};
if (!customElements.get("openclaw-a2ui-host")) customElements.define("openclaw-a2ui-host", OpenClawA2UIHost);

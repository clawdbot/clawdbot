function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const WIDGET_THEME_TOKENS = [
  "surface",
  "card",
  "elevated",
  "text",
  "text-strong",
  "muted",
  "border",
  "border-strong",
  "accent",
  "accent-fill",
  "accent-fg",
  "ok",
  "warn",
  "danger",
  "info",
  "radius",
  "font-body",
  "font-mono",
] as const;

// Baked palettes mirror the host claw theme (ui/src/styles/base.css) so
// fallback renders match Control UI renders, where the theme bridge pushes the
// same host values. Contrast tradeoffs in these pairings are owned by the host
// theme; do not diverge here.
const WIDGET_BASE_STYLES = `:root{color-scheme:light dark;
--surface:#faf9f7;--card:#ffffff;--elevated:#ffffff;
--text:#403c35;--text-strong:#211e1a;--muted:#6e6960;
--border:#e8e4dc;--border-strong:#d6d0c5;
--accent:#bd4531;--accent-fill:#bd4531;--accent-fg:#ffffff;
--ok:#15803d;--warn:#b45309;--danger:#dc2626;--info:#2563eb;
--radius:10px;
--font-body:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
--font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--accent-subtle:color-mix(in srgb,var(--accent) 10%,transparent);
--ok-subtle:color-mix(in srgb,var(--ok) 10%,transparent);
--warn-subtle:color-mix(in srgb,var(--warn) 12%,transparent);
--danger-subtle:color-mix(in srgb,var(--danger) 10%,transparent);
--info-subtle:color-mix(in srgb,var(--info) 10%,transparent)}
@media (prefers-color-scheme:dark){:root{
--surface:#0e1015;--card:#161920;--elevated:#191c24;
--text:#d4d4d8;--text-strong:#f4f4f5;--muted:#8b8b94;
--border:#1e2028;--border-strong:#2e3040;
--accent:#ff5c5c;--accent-fill:#d13c3c;--accent-fg:#ffffff;
--ok:#22c55e;--warn:#f59e0b;--danger:#ef4444;--info:#3b82f6}}
*{box-sizing:border-box}html,body{margin:0}
body{font:14px/1.5 var(--font-body);color:var(--text)}
h1,h2,h3{margin:0 0 8px;color:var(--text-strong);font-weight:600}
h1{font-size:18px}h2{font-size:16px}h3{font-size:14px}
p{margin:0 0 8px}
a{color:var(--accent)}
button{font:13px var(--font-body);color:var(--text);background:var(--card);border:1px solid var(--border-strong);border-radius:var(--radius);padding:6px 14px;cursor:pointer}
button:hover{border-color:var(--muted)}
button.primary{background:var(--accent-fill);color:var(--accent-fg);border-color:transparent}
input,select,textarea{font:13px var(--font-body);color:var(--text);background:var(--elevated);border:1px solid var(--border-strong);border-radius:var(--radius);padding:6px 10px}
input:focus,select:focus,textarea:focus,button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:4px 8px}
td{padding:6px 8px;border-top:1px solid var(--border)}
code,pre{font-family:var(--font-mono);font-size:12px;background:var(--card);border-radius:4px}
code{padding:1px 5px}pre{padding:10px;overflow-x:auto}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px}
.badge{display:inline-block;font-size:12px;padding:2px 10px;border-radius:999px;background:var(--accent-subtle);color:var(--accent)}
.badge.ok{background:var(--ok-subtle);color:var(--ok)}
.badge.warn{background:var(--warn-subtle);color:var(--warn)}
.badge.danger{background:var(--danger-subtle);color:var(--danger)}
.badge.info{background:var(--info-subtle);color:var(--info)}
.metric{font-size:24px;font-weight:600;color:var(--text-strong)}
.muted{color:var(--muted)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.svg-widget{display:grid;place-items:center}.svg-widget>svg{max-width:100%}`;

type WidgetDocumentOptions = {
  connectOrigins?: readonly string[];
};

/** Wraps agent-authored widget markup in the stable isolated Canvas document shell. */
export function buildWidgetDocument(
  title: string,
  widgetCode: string,
  options: WidgetDocumentOptions = {},
): string {
  const isSvg = /^<svg/i.test(widgetCode);
  const bodyClass = isSvg ? ' class="svg-widget"' : "";
  // Inline scripts may drive the widget; CSP blocks resource loads, while preview metadata
  // prevents the iframe from inheriting same-origin access to the parent application.
  // The size reporter lets the embedding chat fit the iframe to the content; the
  // parent clamps reported heights, so widget code cannot abuse the channel.
  const sizeReporter =
    "<script>(()=>{if(!window.parent||window.parent===window)return;" +
    // documentElement.scrollHeight reports the viewport for short content, so
    // measure the body box, which tracks the actual widget height.
    "let last=0;const report=()=>{const b=document.body;if(!b)return;" +
    "const h=Math.ceil(Math.max(b.scrollHeight,b.offsetHeight,b.getBoundingClientRect().height));" +
    'if(h&&h!==last){last=h;window.parent.postMessage({type:"openclaw:widget-size",height:h},"*");}};' +
    "addEventListener('load',report);new ResizeObserver(report).observe(document.body);" +
    "setTimeout(report,50);setTimeout(report,500);})();</script>";
  // This bridge precedes widget code and snapshots every authority-bearing
  // primitive. Inline chat keeps its private prompt port; board hosting adopts
  // the view ticket and routes every host API over one request channel.
  const widgetBridge =
    '<script>(()=>{if(!window.parent||window.parent===window||Object.prototype.hasOwnProperty.call(window,"openclaw"))return;' +
    "const parent=window.parent;const post=parent.postMessage.bind(parent);" +
    "const P=Promise;const then=P.prototype.then;const ErrorCtor=Error;" +
    "const stringify=String;const freeze=Object.freeze;const define=Object.defineProperty;" +
    "const push=Array.prototype.push;const shift=Array.prototype.shift;" +
    "const later=setTimeout.bind(window);const cancel=clearTimeout.bind(window);" +
    "const c=new MessageChannel();" +
    "const promptPost=c.port1.postMessage.bind(c.port1);" +
    "const b=new MessageChannel();const bridgePost=b.port1.postMessage.bind(b.port1);" +
    "const promptWaiting=[];let inlinePromptReady=false;" +
    'c.port1.addEventListener("message",event=>{if(event.data?.type!=="openclaw:widget-prompt-host-ready"||inlinePromptReady)return;' +
    "inlinePromptReady=true;while(promptWaiting.length){const entry=shift.call(promptWaiting);if(entry)entry.inline();}});c.port1.start();" +
    "let act=null;" +
    "try{const ua=navigator.userActivation;" +
    'const d=ua&&Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ua),"isActive");' +
    "if(d&&d.get)act=d.get.bind(ua);}catch{}" +
    'post({type:"openclaw:widget-prompt-offer"},"*",[c.port2]);' +
    'post({type:"openclaw:widget-bridge-port-offer"},"*",[b.port2]);' +
    "let ticket=null;let sequence=0;let hostInitExpired=false;const pending=new Map();const waiting=[];" +
    'const initTimer=later(()=>{hostInitExpired=true;while(waiting.length){const entry=shift.call(waiting);if(entry)entry.reject(new ErrorCtor("widget host capabilities unavailable"));}' +
    'while(promptWaiting.length){const entry=shift.call(promptWaiting);if(entry)entry.reject(new ErrorCtor("widget prompt host unavailable"));}},5000);' +
    'b.port1.addEventListener("message",event=>{const data=event.data;' +
    'if(data?.type==="openclaw:widget-host-init"&&typeof data.ticket==="string"){ticket=data.ticket;' +
    'bridgePost({type:"openclaw:widget-host-init-ack",ticket});cancel(initTimer);' +
    "while(waiting.length){const entry=shift.call(waiting);if(entry)entry.send();}" +
    "while(promptWaiting.length){const entry=shift.call(promptWaiting);if(entry)entry.send();}return;}" +
    'if(data?.type!=="openclaw:widget-bridge-response"||typeof data.id!=="string")return;' +
    "const entry=pending.get(data.id);if(!entry)return;pending.delete(data.id);" +
    'if(data.ok===true)entry.resolve(data.result);else entry.reject(new ErrorCtor(typeof data.error==="string"?data.error:"widget host request failed"));});b.port1.start();' +
    'const request=(method,params)=>new P((resolve,reject)=>{const send=()=>{const id="widget-"+(++sequence);' +
    "pending.set(id,{resolve,reject});" +
    'try{bridgePost({type:"openclaw:widget-bridge-request",id,method,params,ticket});}' +
    "catch(error){pending.delete(id);reject(error);}};" +
    'if(ticket)send();else if(hostInitExpired)reject(new ErrorCtor("widget host capabilities unavailable"));' +
    "else push.call(waiting,{send,reject});});" +
    "const sendPrompt=text=>{if(!act||act()!==true)return P.resolve(false);const value=stringify(text);" +
    'if(ticket)return request("prompt.send",{text:value});return new P((resolve,reject)=>{' +
    'const send=()=>{const result=request("prompt.send",{text:value});then.call(result,resolve,reject);};' +
    'const inline=()=>{promptPost({type:"openclaw:widget-prompt",prompt:value});resolve(true);};' +
    'if(inlinePromptReady)inline();else if(hostInitExpired)reject(new ErrorCtor("widget prompt host unavailable"));' +
    "else push.call(promptWaiting,{send,inline,reject});});};" +
    "const api=freeze({" +
    'prompt:freeze({send:sendPrompt}),state:freeze({emit:payload=>request("state.emit",{payload})}),' +
    'data:freeze({read:(bindingId,params)=>request("data.read",{bindingId:stringify(bindingId),params})}),' +
    'cron:freeze({trigger:jobId=>request("cron.trigger",{jobId:stringify(jobId)})})});' +
    'define(window,"openclaw",{value:api,writable:false,configurable:false});' +
    "window.sendPrompt=text=>{void sendPrompt(text);};" +
    'define(window,"sendPrompt",{value:window.sendPrompt,writable:false,configurable:false});' +
    'post({type:"openclaw:widget-bridge-ready"},"*");})();</script>';
  /*
   * The host may push a new theme after every theme change. Each message is a
   * full snapshot: omitted or invalid tokens are removed so a theme switch
   * falls back to the baked palette instead of keeping stale inline values.
   * Only the fixed widget token allowlist crosses the frame boundary, and the
   * native style setters are captured before widget code can patch them.
   */
  const themeBridge =
    "<script>(()=>{if(!window.parent||window.parent===window)return;" +
    "const root=document.documentElement;const set=root.style.setProperty.bind(root.style);" +
    "const rm=root.style.removeProperty.bind(root.style);" +
    `const keys=${JSON.stringify(WIDGET_THEME_TOKENS)};` +
    'addEventListener("message",event=>{if(event.source!==window.parent)return;' +
    'const data=event.data;if(!data||data.type!=="openclaw:widget-theme"||' +
    'typeof data.tokens!=="object"||data.tokens===null)return;' +
    "for(const key of keys){const raw=data.tokens[key];" +
    'const value=typeof raw==="string"?raw.trim():"";' +
    'if(value&&value.length<=256)set("--"+key,value);else rm("--"+key);}' +
    'if(data.mode==="light"||data.mode==="dark")set("color-scheme",data.mode);});})();</script>';
  /*
   * Snapshot requests come from the embedding parent and replies return only
   * there. Capture the response channel and rendering primitives before widget
   * code can patch them; the widget still owns the document being rendered.
   */
  const snapshotBridge =
    "<script>(()=>{if(!window.parent||window.parent===window)return;" +
    "const parent=window.parent;const post=(message,origin)=>parent.postMessage(message,origin);" +
    "const listen=window.addEventListener.bind(window);" +
    "const clone=Node.prototype.cloneNode;const query=Element.prototype.querySelectorAll;" +
    "const queryDocument=document.querySelectorAll.bind(document);" +
    "const item=NodeList.prototype.item;const remove=Node.prototype.removeChild;" +
    "const replace=Node.prototype.replaceChild;" +
    'const getParent=Object.getOwnPropertyDescriptor(Node.prototype,"parentNode")?.get;' +
    "const names=Element.prototype.getAttributeNames;const getAttr=Element.prototype.getAttribute;" +
    "const setAttr=Element.prototype.setAttribute;" +
    "const serializer=new XMLSerializer();const serialize=serializer.serializeToString.bind(serializer);" +
    "const create=document.createElement.bind(document);const styles=getComputedStyle.bind(window);" +
    "const getProperty=CSSStyleDeclaration.prototype.getPropertyValue;" +
    "const getContext=HTMLCanvasElement.prototype.getContext;" +
    "const toDataURL=HTMLCanvasElement.prototype.toDataURL;" +
    'const setWidth=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,"width")?.set;' +
    'const setHeight=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,"height")?.set;' +
    'const setFill=Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype,"fillStyle")?.set;' +
    "const fill=CanvasRenderingContext2D.prototype.fillRect;" +
    "const draw=CanvasRenderingContext2D.prototype.drawImage;" +
    "const add=EventTarget.prototype.addEventListener;const ImageCtor=Image;" +
    'const setSrc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"src")?.set;' +
    "const encode=encodeURIComponent;const P=Promise;const ErrorCtor=Error;const stringify=String;" +
    "const max=Math.max.bind(Math);const min=Math.min.bind(Math);const ceil=Math.ceil.bind(Math);" +
    'listen("message",event=>{if(event.source!==parent)return;' +
    'const data=event.data;if(!data||data.type!=="openclaw:widget-snapshot-request"||typeof data.id!=="string")return;' +
    "void (async()=>{try{const body=document.body;" +
    "const width=max(1,body.scrollWidth);const height=max(1,body.scrollHeight);" +
    'const root=clone.call(document.documentElement,true);const scripts=query.call(root,"script");' +
    "for(let index=scripts.length-1;index>=0;index--){const script=item.call(scripts,index);" +
    "if(script&&getParent){const owner=getParent.call(script);if(owner)remove.call(owner,script);}}" +
    'const liveCanvases=queryDocument("canvas");const clonedCanvases=query.call(root,"canvas");' +
    "for(let index=0;index<liveCanvases.length;index++){const live=item.call(liveCanvases,index);" +
    "const cloned=item.call(clonedCanvases,index);if(!live||!cloned||!getParent||!setSrc)continue;" +
    'const image=create("img");for(const name of names.call(cloned)){const value=getAttr.call(cloned,name);' +
    'if(value!==null)setAttr.call(image,name,value);}setSrc.call(image,toDataURL.call(live,"image/png"));' +
    "const owner=getParent.call(cloned);if(owner)replace.call(owner,image,cloned);}" +
    'const svg=\'<svg xmlns="http://www.w3.org/2000/svg" width="\'+width+\'" height="\'+height+\'"><foreignObject width="100%" height="100%">\'+serialize(root)+"</foreignObject></svg>";' +
    'const url="data:image/svg+xml;charset=utf-8,"+encode(svg);' +
    "const image=new ImageCtor();await new P((resolve,reject)=>{" +
    'add.call(image,"load",resolve,{once:true});add.call(image,"error",()=>reject(new ErrorCtor("widget snapshot image failed to load")),{once:true});' +
    'if(!setSrc)throw new ErrorCtor("widget snapshot image source unavailable");setSrc.call(image,url);});' +
    'const canvas=create("canvas");const scale=min(window.devicePixelRatio||1,2);' +
    'if(!setWidth||!setHeight)throw new ErrorCtor("widget snapshot canvas dimensions unavailable");' +
    "const canvasWidth=ceil(width*scale);const canvasHeight=ceil(height*scale);" +
    'if(canvasWidth>16384||canvasHeight>16384||canvasWidth*canvasHeight>16777216)throw new ErrorCtor("widget snapshot dimensions exceed limit");' +
    "setWidth.call(canvas,canvasWidth);setHeight.call(canvas,canvasHeight);" +
    'const context=getContext.call(canvas,"2d");if(!context||!setFill)throw new ErrorCtor("widget snapshot canvas unavailable");' +
    'setFill.call(context,getProperty.call(styles(document.documentElement),"--surface"));' +
    "fill.call(context,0,0,canvasWidth,canvasHeight);draw.call(context,image,0,0,canvasWidth,canvasHeight);" +
    'post({type:"openclaw:widget-snapshot",id:data.id,dataUrl:toDataURL.call(canvas,"image/png"),width,height},"*");' +
    '}catch(error){post({type:"openclaw:widget-snapshot",id:data.id,error:stringify(error)},"*");}})();});})();</script>';
  const connectSources = options.connectOrigins?.length
    ? options.connectOrigins.join(" ")
    : "'none'";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src ${connectSources};"><title>${escapeHtml(title)}</title><style>${WIDGET_BASE_STYLES}</style></head><body${bodyClass}>${widgetBridge}${themeBridge}${snapshotBridge}${widgetCode}${sizeReporter}</body></html>`;
}

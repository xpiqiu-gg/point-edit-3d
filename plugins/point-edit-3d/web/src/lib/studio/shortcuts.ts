export const SHORTCUTS = [
  {id:'look',label:'观察',key:'Digit1'}, {id:'pick',label:'点选',key:'Digit2'},
  {id:'box',label:'框选',key:'Digit3'}, {id:'volume',label:'三维框',key:'Digit4'},
  {id:'frame',label:'整幅',key:'Digit5'}, {id:'undo',label:'撤销选择',key:'Backquote'},
  {id:'move',label:'三维框：移动',key:'KeyA'}, {id:'scale',label:'三维框：调整尺寸',key:'KeyD'},
  {id:'confirm',label:'三维框：确认选区',key:'KeyY'}, {id:'reset',label:'三维框：重新放置',key:'KeyR'},
] as const;
export type ShortcutId = typeof SHORTCUTS[number]['id'];
export type ShortcutMap = Record<ShortcutId,string>;
export const DEFAULT_SHORTCUTS = Object.fromEntries(SHORTCUTS.map(item=>[item.id,item.key])) as ShortcutMap;
export async function loadShortcuts():Promise<ShortcutMap> {
  const response=await fetch('/__point_edit_3d/shortcuts',{headers:{'X-Point-Edit':'shortcuts'}});
  if(!response.ok) throw new Error('无法读取快捷键设置');
  const {shortcuts:value}=await response.json();
  if (!value || typeof value !== 'object') return {...DEFAULT_SHORTCUTS};
  const keys=SHORTCUTS.map(x=>value[x.id]);
  if (keys.some(x=>typeof x!=='string'||!x||x.length>80) || new Set(keys).size!==keys.length) throw new Error('快捷键设置无效');
  return Object.fromEntries(SHORTCUTS.map(x=>[x.id,value[x.id]])) as ShortcutMap;
}
export async function saveShortcuts(value:ShortcutMap) {
  const response=await fetch('/__point_edit_3d/shortcuts',{method:'POST',headers:{'Content-Type':'application/json','X-Point-Edit':'shortcuts'},body:JSON.stringify(value)});
  if(response.status===404) throw new Error('预览服务版本过旧，请重新打开预览');
  if(!response.ok || !(await response.json()).ok) throw new Error('快捷键未能保存，请重试');
}
type KeyInput={code:string; key:string; ctrlKey:boolean; altKey:boolean; shiftKey:boolean; metaKey:boolean};
export function shortcutFromEvent(event:KeyInput):string|null {
  if (!event.code || ['Control','Shift','Alt','Meta','CapsLock','Escape','Tab'].includes(event.key) || event.key==='Dead' || event.key==='Process' || event.code==='Unidentified') return null;
  const code=/^Numpad[0-9]$/.test(event.code)?'Digit'+event.code.slice(-1):event.code;
  const modifiers=[event.ctrlKey?'Ctrl':'',event.altKey?'Alt':'',event.shiftKey && code!=='Backquote'?'Shift':'',event.metaKey?'Meta':''].filter(Boolean);
  return [...modifiers,code].join('+');
}
export function shortcutLabel(value:string) {return value.split('+').map(part=>part==='Backquote'?'~':part.replace(/^Digit/,'').replace(/^Key/,'')).join(' + ');}

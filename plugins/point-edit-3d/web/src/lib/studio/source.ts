export const isC4d = new URLSearchParams(window.location.search).get('scene') === 'c4d';
export const sessionId = new URLSearchParams(window.location.search).get('session') || '';
export const sourceInfo = isC4d ? {kind:'c4d', id:null, revision:null, name:'C4D 场景快照', file:'scene.gltf'} : {kind:'blender', id:null, revision:null, name:'Blender 场景快照', file:'scene.glb'};

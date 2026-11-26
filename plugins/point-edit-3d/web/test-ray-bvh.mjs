import assert from 'node:assert/strict';
import * as THREE from 'three';
import {MeshBVH,acceleratedRaycast} from 'three-mesh-bvh';
const geo=new THREE.SphereGeometry(2,80,40), original=[...geo.index.array];
const materials=[new THREE.MeshBasicMaterial({side:THREE.FrontSide}),new THREE.MeshBasicMaterial({side:THREE.DoubleSide})];
geo.clearGroups();const n=geo.index.count;const mid=Math.floor(n/6)*3;geo.addGroup(0,mid,0);geo.addGroup(mid,n-mid,1);
const a=new THREE.Mesh(geo,materials), b=new THREE.Mesh(new THREE.BoxGeometry(3,3,1,18,18,2),new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
a.position.set(-.6,.3,-4);a.scale.set(1.2,.8,1.4);b.position.set(.2,-.4,-9);a.updateMatrixWorld(true);b.updateMatrixWorld(true);
const ray=new THREE.Raycaster(); const rays=[];for(let y=-9;y<=9;y++)for(let x=-9;x<=9;x++)rays.push(new THREE.Vector3(x/18,y/18,-1).normalize());
function capture(){return rays.map(dir=>{ray.set(new THREE.Vector3(0,0,2),dir);const h=ray.intersectObjects([a,b],false)[0];return h?{id:h.object===a?'sphere':'box',distance:h.distance,point:h.point.toArray(),faceIndex:h.faceIndex,materialIndex:h.face?.materialIndex}:null;});}
const old=capture();geo.boundsTree=new MeshBVH(geo,{indirect:true});a.raycast=acceleratedRaycast;ray.firstHitOnly=true;const fast=capture();assert.deepEqual([...geo.index.array],original);for(let i=0;i<old.length;i++){assert.equal(fast[i]?.id,old[i]?.id);if(old[i]){assert.ok(Math.abs(fast[i].distance-old[i].distance)<1e-8);assert.ok(new THREE.Vector3(...fast[i].point).distanceTo(new THREE.Vector3(...old[i].point))<1e-8);assert.equal(fast[i].faceIndex,old[i].faceIndex);assert.equal(fast[i].materialIndex,old[i].materialIndex);}}
console.log('RAY_BVH_PARITY_OK',rays.length);

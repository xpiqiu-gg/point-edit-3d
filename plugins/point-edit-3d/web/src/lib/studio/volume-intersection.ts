import * as THREE from 'three';

/** Select actual mesh triangles intersecting the box, including enclosed vertices. */
export function meshIntersectsVolume(mesh: THREE.Mesh, box: THREE.Box3): boolean {
  mesh.updateWorldMatrix(true, false);
  const bounds = new THREE.Box3().setFromObject(mesh);
  if (!bounds.intersectsBox(box)) return false;
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position) return false;
  const index = geometry.index;
  const count = index ? index.count : position.count;
  const a=new THREE.Vector3(), b=new THREE.Vector3(), c=new THREE.Vector3(), triangle=new THREE.Triangle();
  for (let i=0;i+2<count;i+=3) {
    const ia=index ? index.getX(i):i, ib=index ? index.getX(i+1):i+1, ic=index ? index.getX(i+2):i+2;
    mesh.getVertexPosition(ia,a).applyMatrix4(mesh.matrixWorld);
    mesh.getVertexPosition(ib,b).applyMatrix4(mesh.matrixWorld);
    mesh.getVertexPosition(ic,c).applyMatrix4(mesh.matrixWorld);
    if (box.containsPoint(a)||box.containsPoint(b)||box.containsPoint(c)||box.intersectsTriangle(triangle.set(a,b,c))) return true;
  }
  // If the box is wholly inside a closed mesh, no surface triangle crosses it.
  const center=box.getCenter(new THREE.Vector3());
  const ray=new THREE.Raycaster(center,new THREE.Vector3(0.927,0.271,0.258).normalize());
  const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
  const sides=materials.map(m=>m.side);
  try {
    materials.forEach(m=>{m.side=THREE.DoubleSide;});
    const hits=ray.intersectObject(mesh,false);
    const distances:number[]=[];
    for(const hit of hits) if(!distances.some(d=>Math.abs(d-hit.distance)<1e-6)) distances.push(hit.distance);
    return distances.length%2===1;
  } finally { materials.forEach((m,i)=>{m.side=sides[i];}); }
}

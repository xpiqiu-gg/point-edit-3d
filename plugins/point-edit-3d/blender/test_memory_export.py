import bpy, os, sys, json, base64, struct, glob, tempfile
sys.path.insert(0, os.path.dirname(__file__))
import point_edit_3d
server=point_edit_3d.PointEdit3DServer(host='127.0.0.1',port=0)
mat=bpy.data.materials.new('PointEditProceduralTest');mat.use_nodes=True;mat.diffuse_color=(0.12,0.3,0.05,1)
principled=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
noise=mat.node_tree.nodes.new('ShaderNodeTexNoise');mat.node_tree.links.new(noise.outputs['Color'],principled.inputs['Base Color'])
bpy.data.objects['Cube'].data.materials.clear();bpy.data.objects['Cube'].data.materials.append(mat)
original_nodes=len(mat.node_tree.nodes);original_rgba=tuple(mat.diffuse_color)
# Existing glTF color and texture outputs must remain authoritative.
explicit={'materials':[{'name':mat.name,'pbrMetallicRoughness':{'baseColorFactor':[1,1,1,1]}},{'name':mat.name,'pbrMetallicRoughness':{'baseColorTexture':{'index':0}}}]}
assert server._point_edit_preview_material_fallback(explicit)==[]
assert explicit['materials'][0]['pbrMetallicRoughness']['baseColorFactor']==[1,1,1,1]
assert 'baseColorFactor' not in explicit['materials'][1]['pbrMetallicRoughness']

before=set(glob.glob(os.path.join(tempfile.gettempdir(),'point-edit-*.glb')))
result=server.point_edit_3d_export_preview(in_memory=True)
raw=base64.b64decode(result['glb_base64'],validate=True)
assert result['path'] is None and len(raw)==result['bytes'] and raw[:4]==b'glTF'
n,kind=struct.unpack_from('<I4s',raw,12)
doc=json.loads(raw[20:20+n])
assert doc['asset']['extras']['point_edit_3d']['scene_uid']==result['scene_uid']
compat=doc['asset']['extras']['point_edit_3d']['preview_compatibility']
assert 'PointEditProceduralTest' in compat['approximate_materials']
exported=next(m for m in doc['materials'] if m['name']=='PointEditProceduralTest')
assert all(abs(a-b)<1e-6 for a,b in zip(exported['pbrMetallicRoughness']['baseColorFactor'],original_rgba))
assert len(mat.node_tree.nodes)==original_nodes and tuple(mat.diffuse_color)==original_rgba and principled.inputs['Base Color'].is_linked

assert any(node.get('extras',{}).get('point_edit_3d_uid') for node in doc['nodes'])
assert set(glob.glob(os.path.join(tempfile.gettempdir(),'point-edit-*.glb')))==before
print('MEMORY_GLB_TEST_OK bytes='+str(len(raw)))

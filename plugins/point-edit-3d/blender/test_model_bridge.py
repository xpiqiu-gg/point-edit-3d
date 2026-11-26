"""Run in an isolated background Blender process, never the user's scene."""
import bpy, os, sys, tempfile, uuid
sys.path.insert(0, os.path.dirname(__file__))
import point_edit_3d

scene = bpy.context.scene
scene['_point_edit_3d_scene_uid'] = uuid.uuid4().hex
obj = bpy.data.objects.get('Cube')
obj['_point_edit_3d_uid'] = uuid.uuid4().hex
server = point_edit_3d.PointEdit3DServer(host='127.0.0.1', port=0)
original_path = bpy.data.filepath
target = obj['_point_edit_3d_uid']
scene_id = scene['_point_edit_3d_scene_uid']
result = server.execute_command({'type':'point_edit_3d_execute','params':{'scene_uid':scene_id,'uids':[target], 'code':'point_edit_targets[0].location.x += 2\nprint("modelled")'}})
assert result['status']=='success', result
assert result['result']['executed'] and 'modelled' in result['result']['output'], result
assert obj.location.x == 2 and bpy.data.filepath == original_path
backup = result['result']['backup_path']
assert os.path.isfile(backup)
rejected = server.execute_command({'type':'point_edit_3d_execute','params':{'scene_uid':'0'*32,'uids':[target], 'code':'raise RuntimeError("must not run")'}})
assert rejected['status']=='error' and obj.location.x == 2
partial = server.execute_command({'type':'point_edit_3d_execute','params':{'scene_uid':scene_id,'uids':[target], 'code':'point_edit_targets[0].location.y = 3\nraise ValueError("test failure")'}})
assert not partial['result']['executed'] and partial['result']['partial_changes_possible'] and obj.location.y == 3
assert os.path.isfile(partial['result']['backup_path'])
print('POINT_EDIT_TEST_OK backup=' + backup)

"""Standalone test-only Blender socket; runs in a separate background process."""
import bpy, sys, os, json, socket
sys.path.insert(0, os.path.dirname(__file__))
import point_edit_3d
scene=bpy.context.scene
scene['_point_edit_3d_scene_uid']='a'*32
obj=bpy.data.objects.get('Cube')
if obj: obj['_point_edit_3d_uid']='b'*32
server=point_edit_3d.PointEdit3DServer(host='127.0.0.1',port=0)
with socket.socket() as listener:
    listener.bind(('127.0.0.1',int(sys.argv[-1])))
    listener.listen(5)
    print('TEST_SERVER_READY',flush=True)
    while True:
        conn,_=listener.accept()
        with conn:
            data=b''
            while True:
                data+=conn.recv(65536)
                try:
                    req=json.loads(data.decode('utf8'))
                    break
                except json.JSONDecodeError:
                    continue
            conn.sendall(json.dumps(server.execute_command(req)).encode('utf8'))

"""Point Edit 3D local Blender bridge, based on mcp-for-blender (MIT)."""
bl_info = {
    'name': 'Point Edit 3D',
    'author': 'Point Edit 3D contributors; mcp-for-blender by Siddharth Ahuja',
    'version': (0, 2, 2),
    'blender': (4, 2, 0),
    'location': 'View3D > Sidebar > Point Edit 3D',
    'description': 'Local scene preview and AI modelling bridge',
    'category': '3D View',
}

import bpy
import socket
import threading
import os
import uuid
import io
from contextlib import redirect_stdout
from . import blender_backend

_server = None
_error = None


class PointEdit3DServer(blender_backend.BlenderMCPServer):
    """Reuse the upstream transport but expose only explicit Point Edit commands."""

    def execute_command(self, command):
        try:
            if not isinstance(command, dict) or not isinstance(command.get('params', {}), dict):
                raise ValueError('Invalid request')
            command_type = command.get('type')
            if command_type == 'ping':
                result = {'pong': True, 'service': 'point-edit-3d'}
            elif command_type == 'point_edit_3d_identity':
                result = self.point_edit_3d_identity(**command.get('params', {}))
            elif command_type == 'point_edit_3d_export_preview':
                result = self.point_edit_3d_export_preview(**command.get('params', {}))
            elif command_type == 'point_edit_3d_object_info':
                result = self.point_edit_3d_object_info(**command.get('params', {}))
            elif command_type == 'point_edit_3d_execute':
                result = self.execute_annotation(**command.get('params', {}))
            else:
                raise ValueError('Command not available in Point Edit 3D')
            return {'status': 'success', 'result': result}
        except Exception as error:
            return {'status': 'error', 'message': str(error)}

    def execute_annotation(self, scene_uid, uids, code):
        """Verify current identities, save a separate recovery copy, then execute on Blender's main thread."""
        if not isinstance(code, str) or not code.strip() or len(code) > 200000:
            raise ValueError('Invalid modelling code')
        if len(set(uids)) != len(uids):
            raise ValueError('Duplicate target UID')
        identity = self.point_edit_3d_identity(scene_uid=scene_uid, uids=uids)
        if not identity['scene_matches'] or any(not item['resolved'] for item in identity['objects']):
            raise ValueError('Scene or target identity changed; refresh the preview')
        targets = [self._point_edit_object(uid) for uid in uids]
        backup_dir = os.path.join(os.path.expanduser('~'), '.point-edit-3d', 'backups')
        os.makedirs(backup_dir, exist_ok=True)
        backup_path = os.path.join(backup_dir, 'before-' + uuid.uuid4().hex + '.blend')
        # copy=True writes a separate recovery file without saving over the current document.
        saved = bpy.ops.wm.save_as_mainfile(filepath=backup_path, copy=True, check_existing=False)
        if 'FINISHED' not in saved or not os.path.isfile(backup_path):
            raise RuntimeError('Could not create a recovery copy; code was not run')
        namespace = {'bpy': bpy, 'point_edit_targets': targets, 'point_edit_scene_uid': scene_uid}
        output = io.StringIO()
        try:
            with redirect_stdout(output):
                exec(code, namespace)
            bpy.context.view_layer.update()
            return {'executed': True, 'output': output.getvalue(), 'backup_path': backup_path,
                    'targets': identity['objects'], 'saved_original': False}
        except Exception as error:
            return {'executed': False, 'error': str(error), 'output': output.getvalue(),
                    'backup_path': backup_path, 'partial_changes_possible': True, 'saved_original': False}

    def start(self):
        if bpy.app.background:
            raise RuntimeError('Open Blender normally to start the Point Edit 3D bridge')
        if self.running:
            return
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            self.socket.bind(('127.0.0.1', 9877))
            self.socket.listen(5)
            self.running = True
            self.server_thread = threading.Thread(target=self._server_loop, daemon=True)
            self.server_thread.start()
            bpy.app.timers.register(self._drain_command_queue, persistent=True)
        except Exception:
            self.running = False
            self.socket.close()
            self.socket = None
            raise

    def stop(self):
        self.running = False
        if bpy.app.timers.is_registered(self._drain_command_queue):
            bpy.app.timers.unregister(self._drain_command_queue)
        if self.socket:
            self.socket.close()
            self.socket = None
        with self._clients_lock:
            clients = list(self._clients)
            self._clients.clear()
        for client in clients:
            try: client.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            try: client.close()
            except OSError: pass
        if self.server_thread and self.server_thread.is_alive():
            self.server_thread.join(timeout=1.2)
        self.server_thread = None


def start_bridge():
    global _server, _error
    if _server and _server.running:
        return
    try:
        candidate = PointEdit3DServer(host='127.0.0.1', port=9877)
        candidate.start()
        _server, _error = candidate, None
    except Exception as error:
        _server, _error = None, str(error)


class POINTEDIT3D_OT_start(bpy.types.Operator):
    bl_idname = 'point_edit_3d.start_bridge'
    bl_label = '启动 Point Edit 3D'
    def execute(self, context):
        start_bridge()
        if _error:
            self.report({'ERROR'}, _error)
            return {'CANCELLED'}
        return {'FINISHED'}


class POINTEDIT3D_PT_panel(bpy.types.Panel):
    bl_label = 'Point Edit 3D'
    bl_idname = 'POINTEDIT3D_PT_bridge'
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'Point Edit 3D'
    def draw(self, context):
        layout = self.layout
        if _server and _server.running:
            layout.label(text='已连接：127.0.0.1:9877', icon='CHECKMARK')
        else:
            layout.label(text='连接未启动', icon='ERROR')
            if _error: layout.label(text=_error)
            layout.operator(POINTEDIT3D_OT_start.bl_idname)


def register():
    bpy.utils.register_class(POINTEDIT3D_OT_start)
    bpy.utils.register_class(POINTEDIT3D_PT_panel)
    start_bridge()


def unregister():
    global _server
    if _server:
        _server.stop()
        _server = None
    bpy.utils.unregister_class(POINTEDIT3D_PT_panel)
    bpy.utils.unregister_class(POINTEDIT3D_OT_start)

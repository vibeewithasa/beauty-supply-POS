import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { POSLayout } from "@/components/pos-layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Search, Plus, Trash2, Edit2 } from "lucide-react";
import { toast } from "sonner";
import { describeIpcError } from "@/lib/ipc-error";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}

interface UserWithPin extends User {
  createdAt?: Date;
}

export default function UsersPage() {
  const [deactivating, setDeactivating] = useState<{ id: number; name: string } | null>(null);
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [users, setUsers] = useState<UserWithPin[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingUser, setEditingUser] = useState<UserWithPin | null>(null);
  const [loading, setLoading] = useState(true);

  const [userName, setUserName] = useState("");
  const [userRole, setUserRole] = useState<"admin" | "vendor">("vendor");
  const [userPin, setUserPin] = useState("");

  useEffect(() => {
    const userStr = sessionStorage.getItem("user");
    if (!userStr) {
      navigate("/");
      return;
    }
    const parsedUser = JSON.parse(userStr);
    if (parsedUser.role !== "admin") {
      navigate("/sales");
      return;
    }
    setUser(parsedUser);
    loadUsers();
  }, [navigate]);

  const loadUsers = async () => {
    try {
      setLoading(true);
      const usersData = await window.api.users.getAll();
      setUsers(usersData);
    } catch (error) {
      console.error("Error loading users:", error);
      toast.error("Error al cargar usuarios");
    } finally {
      setLoading(false);
    }
  };

  if (!user || loading) {
    return (
      <POSLayout>
        <div className="flex h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        </div>
    </POSLayout>
    );
  }

  const filteredUsers = users.filter((u) =>
    u.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // New PINs have 6 to 8 digits (the backend enforces it); accounts that still have a legacy 4-digit PIN keep
  // working until their owner changes it.
  const handleCreateUser = async () => {
    if (!userName.trim()) {
      toast.error("El nombre es obligatorio");
      return;
    }
    const pinGiven = userPin.length > 0;
    if (!editingUser && !pinGiven) {
      toast.error("El PIN es obligatorio al crear un usuario");
      return;
    }
    if (pinGiven && !/^\d{6,8}$/.test(userPin)) {
      toast.error("El PIN debe tener de 6 a 8 dígitos");
      return;
    }

    try {
      if (editingUser) {
        // the PIN is only sent when the administrator typed a new one
        await window.api.users.update(editingUser.id, {
          name: userName,
          role: userRole,
          ...(pinGiven ? { pin: userPin } : {}),
        });
        toast.success(pinGiven ? "Usuario actualizado y PIN cambiado" : "Usuario actualizado (PIN sin cambios)");
      } else {
        await window.api.users.create({ name: userName, role: userRole, pin: userPin });
        toast.success("Usuario creado exitosamente");
      }
      await loadUsers();
      resetForm();
    } catch (error) {
      console.error("Error saving user:", error);
      // PIN_EN_USO, ULTIMO_ADMIN, validation errors...: the backend message is already user-readable
      toast.error(describeIpcError(error, "Error al guardar usuario").message);
    }
  };

  // users:delete DEACTIVATES the account (history is kept); nothing is physically deleted
  const handleDeactivateUser = async (id: number) => {
    if (id === user.id) {
      toast.error("No puedes desactivar tu propia cuenta");
      return;
    }
    const target = users.find((u) => u.id === id);
    setDeactivating({ id, name: target?.name ?? "" });
  };

  const confirmDeactivate = async () => {
    if (!deactivating) return;
    const { id } = deactivating;
    setDeactivating(null);
    try {
      await window.api.users.delete(id);
      toast.success("Usuario desactivado");
      await loadUsers();
    } catch (error) {
      console.error("Error deactivating user:", error);
      toast.error(describeIpcError(error, "Error al desactivar usuario").message);
    }
  };

  const handleEditUser = (editUser: UserWithPin) => {
    setEditingUser(editUser);
    setUserName(editUser.name);
    setUserRole(editUser.role);
    setUserPin(""); // No mostramos el PIN por seguridad
    setShowCreateDialog(true);
  };

  const resetForm = () => {
    setUserName("");
    setUserRole("vendor");
    setUserPin("");
    setEditingUser(null);
    setShowCreateDialog(false);
  };

  return (
    <POSLayout>
      <div className="p-4 md:p-6">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl md:text-3xl font-bold">Gestión de Usuarios</h1>
          <Button
            onClick={() => setShowCreateDialog(true)}
            className="btn-pos-primary gap-2 h-12"
          >
            <Plus size={20} />
            Nuevo Usuario
          </Button>
        </div>

        {/* Búsqueda */}
        <Card className="p-4 mb-6">
          <div className="flex gap-2">
            <Search className="text-muted-foreground mt-3" size={20} />
            <Input
              aria-label="Buscar usuarios" placeholder="Buscar por nombre..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="text-base h-12 flex-1"
            />
          </div>
        </Card>

        {/* Tabla de Usuarios */}
        {filteredUsers.length > 0 ? (
          <Card className="overflow-hidden">
            <table className="table-pos w-full">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Rol</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((u) => (
                  <tr key={u.id}>
                    <td className="font-medium">{u.name}</td>
                    <td>
                      <span
                        className={
                          u.role === "admin"
                            ? "badge-pos-active"
                            : "badge-pos-secondary"
                        }
                      >
                        {u.role === "admin" ? "Administrador" : "Vendedor"}
                      </span>
                    </td>
                    <td>
                      <div className="flex gap-2">
                        <Button
                          onClick={() => handleEditUser(u)}
                          variant="outline"
                          size="sm"
                          className="gap-2 h-10"
                        >
                          <Edit2 size={16} />
                          Editar
                        </Button>
                        <Button
                          onClick={() => handleDeactivateUser(u.id)}
                          variant="destructive"
                          size="sm"
                          className="gap-2 h-10"
                          disabled={u.id === user.id}
                        >
                          <Trash2 size={16} />
                          Desactivar
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : (
          <Card className="card-pos-stat text-center py-12">
            <p className="text-muted-foreground">
              {searchTerm
                ? "No hay usuarios que coincidan con tu búsqueda"
                : "No hay usuarios registrados"}
            </p>
          </Card>
        )}
      </div>

      {/* Dialog Crear/Editar */}
      <Dialog
        open={showCreateDialog}
        onOpenChange={(open) => {
          if (!open) resetForm();
          setShowCreateDialog(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingUser ? "Editar Usuario" : "Crear Nuevo Usuario"}
            </DialogTitle>
            <DialogDescription>
              {editingUser
                ? "Actualiza los datos del usuario"
                : "Rellena los datos del nuevo usuario"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-semibold block mb-2">Nombre</label>
              <Input
                placeholder="Nombre completo..."
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                className="h-10"
                autoFocus
              />
            </div>

            <div>
              <label className="text-sm font-semibold block mb-2">
                {editingUser ? "Nuevo PIN (opcional, 6 a 8 dígitos)" : "PIN (6 a 8 dígitos)"}
              </label>
              <Input
                type="password"
                aria-label={editingUser ? "Nuevo PIN" : "PIN"}
                placeholder={editingUser ? "Dejar vacío para conservar el PIN" : "6 a 8 dígitos"}
                value={userPin}
                autoComplete="new-password"
                onChange={(e) => {
                  const value = e.target.value.replace(/\D/g, "").slice(0, 8);
                  setUserPin(value);
                }}
                maxLength={8}
                className="h-10"
              />
              {editingUser && !userPin && (
                <p className="text-xs text-muted-foreground mt-1">
                  El PIN actual no se muestra ni se cambia si dejas este campo vacío
                </p>
              )}
            </div>

            <div>
              <label className="text-sm font-semibold block mb-2">Rol</label>
              <div className="flex gap-3">
                {[
                  { value: "vendor", label: "Vendedor" },
                  { value: "admin", label: "Administrador" },
                ].map((role) => (
                  <Button
                    key={role.value}
                    onClick={() =>
                      setUserRole(role.value as "admin" | "vendor")
                    }
                    variant={userRole === role.value ? "default" : "outline"}
                    className="flex-1"
                    type="button"
                  >
                    {role.label}
                  </Button>
                ))}
              </div>
            </div>

            <Button
              onClick={handleCreateUser}
              className="btn-pos-success w-full h-12"
            >
              {editingUser ? "Actualizar Usuario" : "Crear Usuario"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog open={deactivating !== null} onOpenChange={(o) => !o && setDeactivating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Desactivar este usuario?</AlertDialogTitle>
            <AlertDialogDescription>
              {deactivating?.name ? `${deactivating.name}: ` : ""}Ya no podrá iniciar sesión; su historial se conserva.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeactivate}>Desactivar usuario</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </POSLayout>
  );
}

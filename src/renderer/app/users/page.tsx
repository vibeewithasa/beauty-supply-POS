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
import { Search, Plus, Trash2, Edit2 } from "lucide-react";
import { toast } from "sonner";

interface User {
  id: number;
  name: string;
  role: "admin" | "vendor";
}

interface UserWithPin extends User {
  createdAt?: Date;
}

export default function UsersPage() {
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

  const handleCreateUser = async () => {
    if (!userName.trim() || !userPin.trim()) {
      toast.error("Completa todos los campos");
      return;
    }

    if (userPin.length !== 4 || !/^\d+$/.test(userPin)) {
      toast.error("El PIN debe ser de 4 dígitos");
      return;
    }

    try {
      if (editingUser) {
        // Edit existing user
        await window.api.users.update(editingUser.id, {
          name: userName,
          role: userRole,
          pin: userPin,
        });
        toast.success("Usuario actualizado exitosamente");
      } else {
        // Create new user
        await window.api.users.create({
          name: userName,
          role: userRole,
          pin: userPin,
        });
        toast.success("Usuario creado exitosamente");
      }

      await loadUsers();
      resetForm();
    } catch (error) {
      console.error("Error saving user:", error);
      toast.error("Error al guardar usuario");
    }
  };

  const handleDeleteUser = async (id: number) => {
    if (id === user.id) {
      toast.error("No puedes eliminar tu propia cuenta");
      return;
    }

    if (!confirm("¿Estás seguro de eliminar este usuario?")) {
      return;
    }

    try {
      await window.api.users.delete(id);
      toast.success("Usuario eliminado exitosamente");
      await loadUsers();
    } catch (error) {
      console.error("Error deleting user:", error);
      toast.error("Error al eliminar usuario");
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
      <div className="p-6">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold">Gestión de Usuarios</h1>
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
              placeholder="Buscar por nombre..."
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
                          className="gap-2"
                        >
                          <Edit2 size={16} />
                          Editar
                        </Button>
                        <Button
                          onClick={() => handleDeleteUser(u.id)}
                          variant="destructive"
                          size="sm"
                          className="gap-2"
                          disabled={u.id === user.id}
                        >
                          <Trash2 size={16} />
                          Eliminar
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
                PIN (4 dígitos)
              </label>
              <Input
                type="password"
                placeholder="0000"
                value={userPin}
                onChange={(e) => {
                  const value = e.target.value.replace(/\D/g, "").slice(0, 4);
                  setUserPin(value);
                }}
                maxLength={4}
                className="h-10"
              />
              {editingUser && !userPin && (
                <p className="text-xs text-muted-foreground mt-1">
                  Deja vacío para mantener el PIN actual
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
    </POSLayout>
  );
}

import { ExternalLink, Layers } from "lucide-react";
import { Modal, Notice } from "../ui";

export function DocsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="Tu plataforma. Pieza por pieza."
      subtitle="Una guía honesta para empezar y operar tu instalación."
      onClose={onClose}
      wide
    >
      <div className="docs-content">
        <div className="docs-intro">
          <Layers size={26} />
          <p>
            Harness Cloud conecta un plano de control persistente con entornos Kubernetes aislados.
            No ejecuta el código de tus proyectos en el servidor web.
          </p>
        </div>
        {[
          [
            "01",
            "Crea tu espacio",
            "Registra la primera cuenta administradora. Crea proyectos desde las plantillas y edita o exporta su código inicial. Los siguientes miembros entran por invitación.",
          ],
          [
            "02",
            "Prepara Kubernetes",
            "Necesitas PostgreSQL externo, gVisor o Kata, un CNI con NetworkPolicy, un StorageClass persistente, ingress-nginx y cert-manager. Usa un clúster dedicado a cargas no confiables.",
          ],
          [
            "03",
            "Configura los dominios",
            "El plano de control y los entornos deben estar en dominios registrables distintos. Configura DNS wildcard y TLS. Nunca compartas cookies entre ambos.",
          ],
          [
            "04",
            "Conecta el entorno",
            "Construye y publica las imágenes. Configura WORKSPACE_IMAGE con su digest, DATABASE_URL, ENCRYPTION_KEY, APP_ORIGIN y WORKSPACE_DOMAIN. Despliega API y worker por separado.",
          ],
          [
            "05",
            "Construye con tu agente",
            "Inicia el entorno y abre Harness. Configura tu proveedor en Settings → Models y selecciona /home/coder/project. El agente y el IDE comparten ese volumen, no las credenciales de la plataforma.",
          ],
          [
            "06",
            "Valida antes de abrir",
            "Prueba aislamiento entre usuarios, restauración de backups, carga, DNS y TLS. Los manifiestos no reemplazan una revisión de seguridad ni una operación continua.",
          ],
        ].map(([n, title, text]) => (
          <section className="docs-step" key={n}>
            <span>{n}</span>
            <div>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          </section>
        ))}
        <Notice tone="warning">
          DeepSeek Harness está en developer preview. Su upstream advierte que no está auditado ni
          debe tratarse como production-ready. La instalación suministrada desactiva telemetría y
          contribución de registros, pero las solicitudes al modelo sí envían el contexto necesario
          a tu proveedor.
        </Notice>
        <div className="docs-links">
          <a
            href="https://github.com/deepseek-ai/deepseek-harness"
            target="_blank"
            rel="noopener noreferrer"
          >
            DeepSeek Harness <ExternalLink size={14} />
          </a>
          <a href="https://github.com/coder/code-server" target="_blank" rel="noopener noreferrer">
            code-server <ExternalLink size={14} />
          </a>
        </div>
        <p className="form-fineprint">
          Instrucciones completas y límites conocidos: README.md · docs/DEPLOYMENT.md ·
          docs/SECURITY.md · docs/RELEASE-GATES.md del repositorio.
        </p>
      </div>
    </Modal>
  );
}

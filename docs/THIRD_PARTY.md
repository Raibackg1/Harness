# Dependencias y licencias

Harness Cloud es un proyecto independiente. No es un producto oficial de Replit, DeepSeek o Coder. Los nombres identifican las integraciones; no implican afiliación, aval ni una licencia de marca.

| Componente                                     | Uso                                         | Licencia declarada por upstream                             |
| ---------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| DeepSeek Harness `@deepseek-ai/dsh@0.1.7-rc.2` | Agente dentro del workspace                 | MIT; ver también THIRD_PARTY_NOTICES del proyecto           |
| code-server 4.139.1                            | IDE en navegador                            | MIT; distribución basada en Code OSS con avisos adicionales |
| React / React DOM                              | Frontend                                    | MIT                                                         |
| Fastify y plugins oficiales utilizados         | API                                         | MIT                                                         |
| node-postgres                                  | Cliente PostgreSQL                          | MIT                                                         |
| PGlite                                         | PostgreSQL embebido para desarrollo/pruebas | Apache-2.0 y licencias de sus componentes PostgreSQL/WASM   |
| jose                                           | Firmas y validación JWT                     | MIT                                                         |
| http-proxy                                     | Gateway HTTP/WebSocket                      | MIT                                                         |
| otpauth                                        | TOTP y URI de autenticador                  | MIT                                                         |
| qrcode                                         | Generación local del QR de MFA              | MIT                                                         |
| fflate                                         | ZIP de código inicial                       | MIT                                                         |
| tldts                                          | Frontera de dominio registrable             | MIT; revisar datos de la Public Suffix List                 |
| Lucide                                         | Iconos                                      | ISC                                                         |
| Inter / Manrope                                | Tipografías servidas localmente             | SIL Open Font License 1.1                                   |

Los lockfiles fijan las dependencias de la plataforma y el gateway. Las dependencias transitivas del paquete Harness instalado durante la construcción necesitan su propio inventario de imagen, revisión de licencias y controles de integridad. La tabla es una ayuda de revisión, **no una opinión legal ni un inventario exhaustivo de la imagen completa**.

Fuentes consultadas directamente:

- https://github.com/deepseek-ai/deepseek-harness
- https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md
- https://github.com/coder/code-server

Antes de distribuir comercialmente, generar SBOMs de ambas imágenes y conservar los avisos y licencias correspondientes a las versiones realmente distribuidas. El funcionamiento de extensiones VS Code depende también de sus propias licencias y condiciones de marketplace; no se promete acceso al marketplace propietario de Microsoft.

# Diseño del workbench de Forge Code

El workbench usa superficies de carbón, texto claro, carmín para selección y oro discreto para identidad, foco y estados activos. La identidad visible es **Forge Code**. El símbolo de tres barras tiene fuente vectorial en `electron/assets/forge-logo.svg` y una versión PNG de 512 px para Electron y el AppImage. Los colores se definen en `tailwind.config.js`; las clases compartidas y el foco de teclado viven en `src/index.css`.

## Inicio y navegación

`WelcomeScreen.tsx` muestra acciones reales: abrir una carpeta, conectar por SSH, buscar archivos, abrir Git, terminal, chat, extensiones y preferencias. Con un workspace abierto lista hasta siete archivos del árbol disponible, excluyendo `.git` y `node_modules`. Se presentan como **archivos del proyecto**, porque el editor aún no mantiene un historial de archivos recientes. Una carpeta vacía tiene un mensaje específico.

El inicio no ejecuta comandos de desarrollo asumidos ni muestra métricas derivadas de un árbol parcialmente cargado. La distribución se adapta al ancho del editor mediante container queries, incluso con ambas barras laterales abiertas.

La barra superior mantiene los menús y controles de ventana. El buscador central abre la paleta de comandos y aparece solo cuando hay espacio suficiente. La barra de herramientas muestra texto en pantallas amplias e iconos con nombres accesibles en las más estrechas. La Ayuda usa un diálogo React con foco, cierre con Escape y retorno de foco, para evitar `window.alert()` en Electron.

## Editor y estados

- Las pestañas activas combinan superficie, texto claro y borde carmín; los archivos sin guardar conservan su indicador.
- La navegación por pestañas admite flechas, Inicio y Fin. Cerrar/desanclar tienen nombres accesibles y aparecen al enfocar con teclado.
- La ruta del archivo permanece en una barra compacta con acciones de guardar, Live Server, terminal y comandos.
- El estado inferior muestra Git, errores y advertencias reales, Live Server y guardado automático; los detalles de codificación y sangría ceden espacio en ventanas estrechas.
- El contador de problemas abre directamente Problemas. Los detalles de cursor solo se muestran para documentos de texto.
- Todos los controles reciben un contorno de foco oro. Se respeta la preferencia de movimiento reducido.

## Organización y límites

`EditorArea.tsx` compone el editor. `Editor/EditorChrome.tsx` contiene pestañas y herramientas, `Editor/MonacoWrapper.tsx` aloja Monaco y sus vistas alternativas, `Editor/useEditorSync.ts` conserva la sincronización documental y `Editor/forgeTheme.ts` define el tema integrado. Cada módulo queda por debajo de 400 líneas.

La extracción mantiene los handlers, suscripciones, guardas de streaming, sincronización LSP/extensiones, selección de temas instalados, pestañas de diff y previsualización de imágenes. El tema integrado ajusta el fondo a la nueva superficie y aumenta el contraste de comentarios; los temas de extensiones siguen pasando por el registro existente.

## Ventanas estrechas y redimensionamiento

`App.tsx` reserva una columna flexible con `minmax(0, 1fr)` y limita los paneles al ancho disponible. Por debajo de 720 px, la barra lateral se abre encima del editor. El asistente también se convierte en un panel superpuesto cuando el espacio restante no permite conservar 360 px para el editor. Las superposiciones quedan debajo de las barras superiores y encima de la barra de estado; se muestran u ocultan con los controles habituales. Estos ajustes no sobrescriben los tamaños guardados al reducir temporalmente la ventana.

Los divisores de `ResizeDivider.tsx` admiten arrastre con captura del puntero y foco mediante Tab. Las flechas mueven el borde 16 px: izquierda/derecha para paneles laterales, arriba/abajo para la terminal. Tienen nombre, orientación y valor accesibles, además de un indicador de foco. El panel inferior limita su altura para conservar espacio de edición; la aplicación se adapta al reducir una ventana que tenía la terminal muy alta.

Este cambio no altera formatos de persistencia, IPC ni configuración de proveedores IA.

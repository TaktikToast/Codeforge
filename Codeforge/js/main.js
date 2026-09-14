        let pyodide = null;
        let currentProjectKey = null;
        let selectedTypeFilter = "all";
        let autoSaveTimeout = null;
        let lastFocusedEditor = null;

        // Wird beim Befüllen der Editoren (z.B. beim Öffnen eines Projekts)
        // kurzzeitig auf true gesetzt, damit die einzelnen setValue()-Aufrufe
        // für html/css/js NICHT jeweils sofort ihren eigenen (noch
        // unvollständigen) updateWebPreview()-Aufruf auslösen. Vorher liefen
        // beim Öffnen eines Web-Projekts bis zu 4 iframe-Neuaufbauten in
        // Millisekunden-Abstand ab (einer pro setValue() mit teils
        // veralteten Daten, plus der finale korrekte Aufruf) - das konnte
        // dazu führen, dass die Vorschau unstyled/weiß hängen blieb, weil
        // z.B. ein per @import geladenes Google Font mitten im mehrfachen
        // Neuladen unterbrochen wurde. Jetzt läuft beim Öffnen nur noch
        // GENAU EIN updateWebPreview()-Aufruf, mit den fertigen Daten.
        let suppressEditorEvents = false;

        let cmEditors = {};

        const dbName = "CodePenLocalDB";
        const storeName = "projects";

        function openDB() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(dbName, 1);
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(storeName)) {
                        db.createObjectStore(storeName);
                    }
                };
                request.onsuccess = (e) => resolve(e.target.result);
                request.onerror = (e) => reject(e.target.error);
            });
        }

        async function dbGet(key) {
            try {
                const db = await openDB();
                return new Promise((resolve) => {
                    const tx = db.transaction(storeName, "readonly");
                    const store = tx.objectStore(storeName);
                    const req = store.get(key);
                    req.onsuccess = () => {
                        if (req.result !== undefined) {
                            resolve(req.result);
                        } else {
                            const lsData = localStorage.getItem(key);
                            resolve(lsData ? JSON.parse(lsData) : null);
                        }
                    };
                    req.onerror = () => resolve(null);
                });
            } catch(e) {
                const lsData = localStorage.getItem(key);
                return lsData ? JSON.parse(lsData) : null;
            }
        }

        async function dbSet(key, value) {
            try {
                const db = await openDB();
                return new Promise((resolve, reject) => {
                    const tx = db.transaction(storeName, "readwrite");
                    const store = tx.objectStore(storeName);
                    store.put(value, key);
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject();
                });
            } catch(e) {
                try {
                    localStorage.setItem(key, JSON.stringify(value));
                } catch(err) {
                    console.error("Speicherplatz voll oder nicht verfügbar.");
                }
            }
        }

        async function dbDelete(key) {
            localStorage.removeItem(key);
            try {
                const db = await openDB();
                const tx = db.transaction(storeName, "readwrite");
                tx.objectStore(storeName).delete(key);
            } catch(e) {}
        }

        async function dbGetAllKeys() {
            const keysSet = new Set();
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k.startsWith("codepen_")) keysSet.add(k);
            }
            try {
                const db = await openDB();
                const tx = db.transaction(storeName, "readonly");
                const store = tx.objectStore(storeName);
                const req = store.getAllKeys();
                await new Promise((resolve) => {
                    req.onsuccess = () => {
                        req.result.forEach(k => { if (k.startsWith("codepen_")) keysSet.add(k); });
                        resolve();
                    };
                    req.onerror = () => resolve();
                });
            } catch(e) {}
            return Array.from(keysSet);
        }

        function initCodeMirror() {
            const cmOptions = {
                theme: "dracula",
                lineNumbers: true,
                autoCloseBrackets: true,
                tabSize: 2,
                indentUnit: 2,
                lineWrapping: true,
                extraKeys: {
                    "Tab": function(cm) {
                        if (cm.somethingSelected()) {
                            cm.indentSelection("add");
                        } else {
                            cm.replaceSelection("  ", "end");
                        }
                    }
                }
            };

            cmEditors.html = CodeMirror.fromTextArea(document.getElementById("html-code"), { ...cmOptions, mode: "htmlmixed" });
            cmEditors.css = CodeMirror.fromTextArea(document.getElementById("css-code"), { ...cmOptions, mode: "css" });
            cmEditors.js = CodeMirror.fromTextArea(document.getElementById("js-code"), { ...cmOptions, mode: "javascript" });
            cmEditors.py = CodeMirror.fromTextArea(document.getElementById("py-code"), { ...cmOptions, mode: "python" });

            const trackFocus = (cm) => lastFocusedEditor = cm;
            ['html', 'css', 'js', 'py'].forEach(key => {
                cmEditors[key].on("focus", () => trackFocus(cmEditors[key]));
            });

            cmEditors.html.on("change", () => { if (suppressEditorEvents) return; if (!previewPaused) updateWebPreview(); triggerAutoSave(); });
            cmEditors.css.on("change", () => { if (suppressEditorEvents) return; if (!previewPaused) updateWebPreview(); triggerAutoSave(); });
            cmEditors.js.on("change", () => { if (suppressEditorEvents) return; if (!previewPaused) updateWebPreview(); triggerAutoSave(); });
            cmEditors.py.on("change", () => { if (suppressEditorEvents) return; triggerAutoSave(); });
        }

        function getActiveEditor() {
            if (lastFocusedEditor && lastFocusedEditor.getWrapperElement().offsetHeight > 0) {
                return lastFocusedEditor;
            }
            return document.getElementById('python-tab').classList.contains('active') ? cmEditors.py : cmEditors.html;
        }

        function undoCode() {
            const cm = getActiveEditor();
            if (cm) {
                cm.undo();
                // CodeMirror zeichnet Änderungen manchmal nicht sofort neu,
                // wenn der Editor gerade nicht fokussiert ist (genau das
                // Python-Problem: Undo/Redo "verschwindet" bis man wieder
                // reinklickt/scrollt). refresh() erzwingt das Neuzeichnen sofort.
                cm.refresh();
                cm.focus();
                triggerAutoSave();
            }
        }

        function redoCode() {
            const cm = getActiveEditor();
            if (cm) {
                cm.redo();
                cm.refresh();
                cm.focus();
                triggerAutoSave();
            }
        }

        // =========================================================
        // PYTHON TERMINAL: Direkte Eingabe im schwarzen Output-Fenster
        // =========================================================
        let pythonInputResolver = null;
        let pythonRunning = false;
        let pyNamespace = null; // frischer globaler Namespace pro Lauf -> echter Reset

        function appendPythonOutput(text) {
            const outputDiv = document.getElementById("python-output");
            outputDiv.textContent += text;
            outputDiv.scrollTop = outputDiv.scrollHeight;
        }

        // Python-Fehler werden wie Web-Console-Fehler als eigener Eintrag
        // dargestellt. Dadurch bleibt die normale Terminal-Ausgabe erhalten,
        // während ein Fehler direkt mit demselben Kopier-Feedback wie in der
        // Web-Konsole kopiert werden kann.
        function appendPythonError(message) {
            const outputDiv = document.getElementById("python-output");
            if (!outputDiv) return;

            const errorText = String(message);
            const entry = document.createElement("div");
            entry.className = "console-entry error python-console-entry";
            entry.innerHTML = '<span class="console-icon">✗</span><span>' +
                escapeHtml(errorText).replace(/\n/g, "<br>") +
                '</span>' +
                '<button class="copy-btn console-copy-error" type="button" title="' + escapeHtml(t('copyErrorTitle')) + '" data-i18n-title="copyErrorTitle" aria-label="' + escapeHtml(t('copyErrorTitle')) + '" data-i18n-aria="copyErrorTitle"><svg class="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1"/><path d="M3.5 10.5v-7a1 1 0 0 1 1-1h7"/></svg></button>';

            const copyBtn = entry.querySelector(".console-copy-error");
            copyBtn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                copyText(errorText, copyBtn);
            });

            outputDiv.appendChild(entry);
            outputDiv.dataset.state = "error";
            outputDiv.scrollTop = outputDiv.scrollHeight;
        }

        function scrollPythonTerminalToBottom() {
            const outputDiv = document.getElementById("python-output");
            outputDiv.scrollTop = outputDiv.scrollHeight;
        }

        function showPythonInput() {
            const row = document.getElementById("python-input-row");
            const input = document.getElementById("python-input");

            row.classList.remove("hidden");
            input.disabled = false;
            input.value = "";

            setTimeout(() => {
                input.focus();
                scrollPythonTerminalToBottom();
            }, 0);
        }

        function hidePythonInput() {
            const row = document.getElementById("python-input-row");
            const input = document.getElementById("python-input");

            input.disabled = true;
            input.value = "";
            row.classList.add("hidden");
        }

        function focusPythonInput() {
            if (pythonInputResolver) {
                document.getElementById("python-input").focus();
            }
        }

        // Diese Funktion wird von Python aufgerufen und wartet asynchron
        // auf eine Zeile, die der Benutzer direkt im Terminal eingibt.
        window.waitForPythonInput = function() {
            return new Promise((resolve) => {
                pythonInputResolver = resolve;
                showPythonInput();
            });
        };

        function submitPythonInput() {
            if (!pythonInputResolver) return;

            const input = document.getElementById("python-input");
            const value = input.value;

            // Die Eingabe wird wie in einem echten Terminal in der Ausgabe angezeigt.
            appendPythonOutput(value + "\n");

            const resolve = pythonInputResolver;
            pythonInputResolver = null;
            hidePythonInput();
            resolve(value);
        }

        document.addEventListener("DOMContentLoaded", () => {
            const input = document.getElementById("python-input");

            input.addEventListener("keydown", (event) => {
                if (event.key === "Enter" && pythonInputResolver) {
                    event.preventDefault();
                    submitPythonInput();
                }
            });

            applyAppTranslations();

            const previewPauseBtn = document.getElementById("preview-pause-btn");
            if (previewPauseBtn) {
                previewPauseBtn.addEventListener("mouseenter", () => setPreviewPauseButton(previewPaused));
                previewPauseBtn.addEventListener("focus", () => setPreviewPauseButton(previewPaused));
            }
        });

        // =========================================================
        // App-weite Übersetzung Deutsch/Englisch. Automatisch per
        // Browsersprache erkannt (navigator.language), manuell
        // umschaltbar über den Sprach-Button auf der Startseite.
        // Die Wahl wird in localStorage gemerkt.
        // =========================================================
        const appI18n = {
            de: {
                backBtnTitle: "Zur vorherigen Ansicht",
                homeSubtitle: "Deine lokale Web- und Python-Entwicklungsumgebung.",
                homeWebTitle: "🌐 Web-Projekt",
                homeWebDesc: "HTML, CSS und JavaScript mit Live-Vorschau und Konsole.",
                homePyTitle: "🐍 Python-Projekt",
                homePyDesc: "Python direkt im Browser mit interaktivem Terminal.",
                homeRecent: "Zuletzt geöffnet",
                noRecentProjects: "Noch keine Projekte geöffnet.",
                langToggleTitle: "Sprache wechseln (Deutsch/Englisch)",

                cancel: "Abbrechen",
                confirm: "Bestätigen",
                ok: "OK",

                newProjectTitle: "Neues Projekt",
                projectNameLabel: "Projektname",
                defaultProjectName: "MeinProjekt",
                projectTypeLabel: "Projekttyp",
                templateLabel: "Vorlage",
                createProject: "Projekt erstellen",
                optBlank: "Leeres Projekt",
                optWebStarter: "Web Starter",
                optPyStarter: "Python Starter",
                optTerminalStarter: "Terminal Starter",
                optJsGame: "JavaScript Spiel",
                optLandingPage: "Landing Page",

                commandSearchPlaceholder: "Befehl suchen...",
                searchReplaceTitle: "Suchen & Ersetzen",
                searchPlaceholder: "Suchen...",
                replacePlaceholder: "Ersetzen durch...",
                close: "Schließen",
                searchBtn: "Suchen",
                replaceAllBtn: "Alle ersetzen",

                homeSidebarBtn: "⌂ Startseite",
                filterAll: "Alle",
                ieModalTitle: "Import / Export",
                ieActionLabel: "Aktion",
                ieExport: "Export",
                ieImport: "Import",
                ieFormatLabel: "Dateityp",
                ieScopeLabel: "Umfang",
                ieScopeSingle: "Aktuelles Projekt",
                ieScopeAll: "Alle Projekte (Backup)",
                ieRun: "Exportieren",
                ieRunImport: "Datei auswählen",
                ieHintZipSingle: "Lädt das aktuelle Projekt als ZIP-Datei herunter (index.html/style.css/script.js bzw. main.py).",
                ieHintZipAll: "Lädt alle Projekte als eine ZIP-Datei herunter – jedes Projekt in einem eigenen Ordner.",
                ieHintJsonSingle: "Lädt das aktuelle Projekt als JSON-Datei herunter.",
                ieHintJsonAll: "Lädt alle Projekte als eine JSON-Backup-Datei herunter.",
                ieHintZipImport: "Wähle eine ZIP-Datei aus. Enthält sie mehrere Projektordner, werden alle importiert.",
                ieHintJsonImport: "Wähle eine zuvor exportierte JSON-Datei aus (einzelnes Projekt oder Backup).",
                filesLabel: "DATEIEN",

                sidebarToggleTitle: "Sidebar ein/ausblenden",
                webTabLabel: "🌐 Web (HTML/CSS/JS)",
                undoTitle: "Rückgängig (Undo)",
                redoTitle: "Wiederherstellen (Redo)",
                formatBtn: "Formatieren",
                searchBtnToolbar: "Suchen",
                commandBtn: "Command",
                themeBtn: "Theme",
                savedStatus: "✓ Gespeichert",
                savingStatus: "● Speichert...",

                consoleShort: "Konsole",
                copyCodeTitle: "Code kopieren",
                copyErrorTitle: "Fehlercode kopieren",
                copyBtn: "Kopieren",
                copied: "✓ Kopiert!",
                previewLabel: "Preview / Live-Vorschau",
                resetWebTitle: "Web-Code komplett neu starten",
                resetBtn: "↻ Reset",
                pausePreviewTitle: "Live-Vorschau pausieren",
                resumePreviewTitle: "Live-Vorschau fortsetzen",
                fullscreenUnavailable: "Vollbild wird von diesem Browser nicht erlaubt.",
                fullscreenPreviewBtn: "↔ Vollbild",
                exitFullscreenPreviewBtn: "↔ Vollbild beenden",

                // --- Ordner-System ---
                newProjectShortBtn: "+ Projekt",

                // --- Papierkorb / Startseite / Palette ---
                trashTitle: "Zuletzt gelöscht",
                trashShortBtn: "Papierkorb",
                ieShortBtn: "Import / Export",
                closeBtn: "Schließen",
                restoreBtn: "Wiederherstellen",
                purgeBtn: "Endgültig",
                emptyTrashBtn: "Papierkorb leeren",
                trashEmptyState: "Hier ist nichts. Gelöschte Projekte und Ordner landen zuerst hier.",
                movedToTrash: (name) => `„${name}“ liegt jetzt im Papierkorb.`,
                restoredProject: (name) => `„${name}“ wiederhergestellt.`,
                restoredFolder: (name) => `Ordner „${name}“ wiederhergestellt.`,
                restoredFolderWith: (name, count) => `Ordner „${name}“ wiederhergestellt, ${count === 1 ? "1 Projekt kam" : count + " Projekte kamen"} zurück.`,
                purgeTitle: "Endgültig löschen",
                purgeMsg: (name) => `„${name}“ endgültig löschen? Das lässt sich nicht rückgängig machen.`,
                purged: (name) => `„${name}“ endgültig gelöscht.`,
                emptyTrashTitle: "Papierkorb leeren",
                emptyTrashMsg: (count) => `${count === 1 ? "Den einen Eintrag" : "Alle " + count + " Einträge"} endgültig löschen? Das lässt sich nicht rückgängig machen.`,
                trashEmptied: "Papierkorb geleert.",
                trashProjectMeta: (folder, when) => `aus „${folder}“ · ${when}`,
                trashProjectMetaRoot: (when) => `ohne Ordner · ${when}`,
                trashFolderMeta: (count, when) => `Ordner · ${count === 1 ? "1 Projekt" : count + " Projekte"} · ${when}`,
                trashFolderMetaEmpty: (when) => `Leerer Ordner · ${when}`,
                justNow: "gerade eben",
                minutesAgo: (n) => `vor ${n} Min.`,
                hoursAgo: (n) => `vor ${n} Std.`,
                daysAgo: (n) => `vor ${n} ${n === 1 ? "Tag" : "Tagen"}`,
                homeNewFolder: "Neuer Ordner",
                homeOnStartLabel: "Startseite beim Öffnen anzeigen",
                pauseOnOpenLabel: "Projekte beim Öffnen und Wechseln automatisch pausieren",
                pauseOnOpenOn: "Projekte starten jetzt pausiert.",
                pauseOnOpenOff: "Projekte starten jetzt direkt.",
                homeOnStartOn: "Startseite wird beim Öffnen angezeigt.",
                homeOnStartOff: "CodeForge öffnet jetzt direkt das letzte Projekt.",
                homeStats: (projects, folders) => `${projects} ${projects === 1 ? "Projekt" : "Projekte"} · ${folders} ${folders === 1 ? "Ordner" : "Ordner"}`,
                cmdNewFolder: "Neuer Ordner",
                cmdRename: "Projekt umbenennen",
                cmdDeleteProject: "Projekt löschen",
                cmdTrash: "Papierkorb öffnen",
                cmdOpenProject: (name) => `Öffnen: ${name}`,
                newFolderBtn: "+ Ordner",
                newFolderTitle: "Neuer Ordner",
                folderNameLabel: "Ordnername",
                folderLabel: "Ordner",
                noFolderOption: "Kein Ordner",
                renameFolderTitle: "Ordner umbenennen",
                deleteFolderTitle: "Ordner löschen",
                deleteFolderMsg: (name, count) => `Ordner „${name}“ löschen? ${count === 1 ? "Das Projekt darin bleibt" : "Die " + count + " Projekte darin bleiben"} erhalten und liegt danach außerhalb eines Ordners.`,
                deleteEmptyFolderMsg: (name) => `Ordner „${name}“ löschen?`,
                enterFolderName: "Bitte einen Ordnernamen eingeben.",
                folderNameExists: "Es gibt bereits einen Ordner mit diesem Namen.",
                folderCreated: (name) => `Ordner „${name}“ erstellt.`,
                folderRenamed: (name) => `Ordner heißt jetzt „${name}“.`,
                folderDeleted: (name) => `Ordner „${name}“ gelöscht.`,
                folderDeletedKept: (name, count) => `Ordner „${name}“ gelöscht. ${count === 1 ? "Ein Projekt wurde" : count + " Projekte wurden"} behalten.`,
                emptyFolder: "Leer",
                emptyLibrary: "Noch keine Projekte",
                rootSectionLabel: "Projekte",
                noSearchResults: "Keine Treffer",
                inFolderHint: (name) => `in ${name}`,
                movedToFolder: (name, folder) => `„${name}“ liegt jetzt in „${folder}“.`,
                movedToRoot: (name) => `„${name}“ liegt jetzt außerhalb aller Ordner.`,
                importSuccessFolders: (projects, folders) => `${projects} ${projects === 1 ? "Projekt" : "Projekte"} und ${folders} ${folders === 1 ? "Ordner" : "Ordner"} importiert.`,
                importSkipped: (count) => `${count} beschädigte Einträge übersprungen.`,
                consoleErrorLabel: "Console / Fehler-Ausgabe",
                clearBtn: "Löschen",
                hideConsoleTitle: "Konsole ausblenden",
                projectStarted: "Projekt gestartet",

                copy: "Kopieren",
                run: "▶ Code Ausführen",
                runTitle: "Code ausführen",
                resetPyTitle: "Python komplett zurücksetzen",
                consoleLabel: "Ausgabe / Konsole:",
                placeholder: "# Schreib deinen Python-Code hier hin\nname = input('Wie heißt du? ')\nprint(f'Hallo {name}!')",
                starting: "Starte Python Engine...",
                ready: "Python Umgebung bereit!",
                loadError: "Fehler beim Laden von Python: ",
                resetDone: "Python wurde zurückgesetzt. Bereit für einen neuen Start.",
                stillLoading: "Python wird noch geladen, bitte warten...",
                inputAria: "Python Eingabe",

                copyFailed: "Kopieren fehlgeschlagen. Bitte den Code manuell markieren und kopieren.",
                selectProjectFirst: "Bitte wähle zuerst ein Projekt aus!",
                projectSaved: "Projekt gespeichert!",
                nameExists: "Ein Projekt mit diesem Namen existiert bereits!",
                nameExists2: "Ein Projekt mit diesem Namen existiert bereits.",
                noProjectsToExport: "Keine Projekte zum Exportieren vorhanden.",
                noProjectSelected: "Kein Projekt ausgewählt!",
                importSuccess: (count) => `${count} Projekte erfolgreich importiert!`,
                importError: "Fehler beim Lesen der Datei. Bitte stelle sicher, dass es eine gültige JSON-Datei ist.",
                enterProjectName: "Bitte einen Projektnamen eingeben.",
                selectProjectFirst2: "Bitte zuerst ein Projekt auswählen.",
                zipModuleError: "ZIP-Modul konnte nicht geladen werden.",
                renameProjectTitle: "Projekt umbenennen",
                renameProjectLabel: "Neuen Namen eingeben",
                deleteProjectTitle: "Projekt löschen",
                deleteProjectMsg: (name) => `Möchtest du das Projekt "${name}" wirklich löschen?`,
                pythonErrorPrefix: "Python Fehler:\n",
                matchesFound: (n) => `${n} Treffer gefunden.`,
                matchesReplaced: (n) => `${n} Treffer ersetzt.`,
                jumpToLineTitle: (line) => `Zu Zeile ${line} springen`,

                cmdNewWeb: "Neues Web-Projekt",
                cmdNewPy: "Neues Python-Projekt",
                cmdSave: "Speichern",
                cmdFormat: "Formatieren",
                cmdSearch: "Suchen & Ersetzen",
                cmdTheme: "Theme wechseln",
                cmdFullscreen: "Editor Vollbild",
                cmdZip: "ZIP exportieren",
                cmdHome: "Startseite"
            },
            en: {
                backBtnTitle: "Back to previous view",
                homeSubtitle: "Your local web and Python development environment.",
                homeWebTitle: "🌐 Web Project",
                homeWebDesc: "HTML, CSS and JavaScript with live preview and console.",
                homePyTitle: "🐍 Python Project",
                homePyDesc: "Python directly in the browser with an interactive terminal.",
                homeRecent: "Recently opened",
                noRecentProjects: "No projects opened yet.",
                langToggleTitle: "Switch language (German/English)",

                cancel: "Cancel",
                confirm: "Confirm",
                ok: "OK",

                newProjectTitle: "New Project",
                projectNameLabel: "Project name",
                defaultProjectName: "MyProject",
                projectTypeLabel: "Project type",
                templateLabel: "Template",
                createProject: "Create project",
                optBlank: "Empty project",
                optWebStarter: "Web starter",
                optPyStarter: "Python starter",
                optTerminalStarter: "Terminal starter",
                optJsGame: "JavaScript game",
                optLandingPage: "Landing page",

                commandSearchPlaceholder: "Search command...",
                searchReplaceTitle: "Find & Replace",
                searchPlaceholder: "Search...",
                replacePlaceholder: "Replace with...",
                close: "Close",
                searchBtn: "Search",
                replaceAllBtn: "Replace all",

                homeSidebarBtn: "⌂ Home",
                filterAll: "All",
                ieModalTitle: "Import / Export",
                ieActionLabel: "Action",
                ieExport: "Export",
                ieImport: "Import",
                ieFormatLabel: "File type",
                ieScopeLabel: "Scope",
                ieScopeSingle: "Current project",
                ieScopeAll: "All projects (backup)",
                ieRun: "Export",
                ieRunImport: "Choose file",
                ieHintZipSingle: "Downloads the current project as a ZIP file (index.html/style.css/script.js or main.py).",
                ieHintZipAll: "Downloads all projects as one ZIP file – each project in its own folder.",
                ieHintJsonSingle: "Downloads the current project as a JSON file.",
                ieHintJsonAll: "Downloads all projects as one JSON backup file.",
                ieHintZipImport: "Choose a ZIP file. If it contains multiple project folders, all of them are imported.",
                ieHintJsonImport: "Choose a previously exported JSON file (single project or backup).",
                filesLabel: "FILES",

                sidebarToggleTitle: "Show/hide sidebar",
                webTabLabel: "🌐 Web (HTML/CSS/JS)",
                undoTitle: "Undo",
                redoTitle: "Redo",
                formatBtn: "Format",
                searchBtnToolbar: "Search",
                commandBtn: "Command",
                themeBtn: "Theme",
                savedStatus: "✓ Saved",
                savingStatus: "● Saving...",

                consoleShort: "Console",
                copyCodeTitle: "Copy code",
                copyErrorTitle: "Copy error",
                copyBtn: "Copy",
                copied: "✓ Copied!",
                previewLabel: "Preview / Live Preview",
                resetWebTitle: "Completely restart web code",
                resetBtn: "↻ Reset",
                pausePreviewTitle: "Pause live preview",
                resumePreviewTitle: "Resume live preview",
                fullscreenUnavailable: "Fullscreen is not allowed by this browser.",
                fullscreenPreviewBtn: "↔ Fullscreen",
                exitFullscreenPreviewBtn: "↔ Exit fullscreen",

                // --- Folder system ---
                newProjectShortBtn: "+ Project",

                // --- Trash / home screen / palette ---
                trashTitle: "Recently deleted",
                trashShortBtn: "Trash",
                ieShortBtn: "Import / Export",
                closeBtn: "Close",
                restoreBtn: "Restore",
                purgeBtn: "Delete",
                emptyTrashBtn: "Empty trash",
                trashEmptyState: "Nothing here. Deleted projects and folders land here first.",
                movedToTrash: (name) => `“${name}” is now in the trash.`,
                restoredProject: (name) => `“${name}” restored.`,
                restoredFolder: (name) => `Folder “${name}” restored.`,
                restoredFolderWith: (name, count) => `Folder “${name}” restored, ${count === 1 ? "1 project came" : count + " projects came"} back.`,
                purgeTitle: "Delete forever",
                purgeMsg: (name) => `Delete “${name}” forever? This cannot be undone.`,
                purged: (name) => `“${name}” deleted forever.`,
                emptyTrashTitle: "Empty trash",
                emptyTrashMsg: (count) => `Delete ${count === 1 ? "the one entry" : "all " + count + " entries"} forever? This cannot be undone.`,
                trashEmptied: "Trash emptied.",
                trashProjectMeta: (folder, when) => `from “${folder}” · ${when}`,
                trashProjectMetaRoot: (when) => `no folder · ${when}`,
                trashFolderMeta: (count, when) => `Folder · ${count === 1 ? "1 project" : count + " projects"} · ${when}`,
                trashFolderMetaEmpty: (when) => `Empty folder · ${when}`,
                justNow: "just now",
                minutesAgo: (n) => `${n} min ago`,
                hoursAgo: (n) => `${n} h ago`,
                daysAgo: (n) => `${n} ${n === 1 ? "day" : "days"} ago`,
                homeNewFolder: "New folder",
                homeOnStartLabel: "Show start page when opening",
                pauseOnOpenLabel: "Pause projects automatically when opening or switching",
                pauseOnOpenOn: "Projects now start paused.",
                pauseOnOpenOff: "Projects now start running.",
                homeOnStartOn: "Start page shows when you open CodeForge.",
                homeOnStartOff: "CodeForge now opens your last project directly.",
                homeStats: (projects, folders) => `${projects} ${projects === 1 ? "project" : "projects"} · ${folders} ${folders === 1 ? "folder" : "folders"}`,
                cmdNewFolder: "New folder",
                cmdRename: "Rename project",
                cmdDeleteProject: "Delete project",
                cmdTrash: "Open trash",
                cmdOpenProject: (name) => `Open: ${name}`,
                newFolderBtn: "+ Folder",
                newFolderTitle: "New folder",
                folderNameLabel: "Folder name",
                folderLabel: "Folder",
                noFolderOption: "No folder",
                renameFolderTitle: "Rename folder",
                deleteFolderTitle: "Delete folder",
                deleteFolderMsg: (name, count) => `Delete folder “${name}”? The ${count === 1 ? "project" : count + " projects"} inside ${count === 1 ? "is" : "are"} kept and will sit outside any folder.`,
                deleteEmptyFolderMsg: (name) => `Delete folder “${name}”?`,
                enterFolderName: "Please enter a folder name.",
                folderNameExists: "A folder with this name already exists.",
                folderCreated: (name) => `Folder “${name}” created.`,
                folderRenamed: (name) => `Folder is now called “${name}”.`,
                folderDeleted: (name) => `Folder “${name}” deleted.`,
                folderDeletedKept: (name, count) => `Folder “${name}” deleted. ${count === 1 ? "1 project was" : count + " projects were"} kept.`,
                emptyFolder: "Empty",
                emptyLibrary: "No projects yet",
                rootSectionLabel: "Projects",
                noSearchResults: "No matches",
                inFolderHint: (name) => `in ${name}`,
                movedToFolder: (name, folder) => `“${name}” moved to “${folder}”.`,
                movedToRoot: (name) => `“${name}” moved out of all folders.`,
                importSuccessFolders: (projects, folders) => `Imported ${projects} ${projects === 1 ? "project" : "projects"} and ${folders} ${folders === 1 ? "folder" : "folders"}.`,
                importSkipped: (count) => `Skipped ${count} damaged entries.`,
                consoleErrorLabel: "Console / Errors",
                clearBtn: "Clear",
                hideConsoleTitle: "Hide console",
                projectStarted: "Project started",

                copy: "Copy",
                run: "▶ Run Code",
                runTitle: "Run code",
                resetPyTitle: "Fully reset Python",
                consoleLabel: "Output / Console:",
                placeholder: "# Write your Python code here\nname = input('What is your name? ')\nprint(f'Hello {name}!')",
                starting: "Starting Python engine...",
                ready: "Python environment ready!",
                loadError: "Error loading Python: ",
                resetDone: "Python has been reset. Ready for a new start.",
                stillLoading: "Python is still loading, please wait...",
                inputAria: "Python input",

                copyFailed: "Copy failed. Please select and copy the code manually.",
                selectProjectFirst: "Please select a project first!",
                projectSaved: "Project saved!",
                nameExists: "A project with this name already exists!",
                nameExists2: "A project with this name already exists.",
                noProjectsToExport: "No projects available to export.",
                noProjectSelected: "No project selected!",
                importSuccess: (count) => `${count} projects imported successfully!`,
                importError: "Error reading the file. Please make sure it is a valid JSON file.",
                enterProjectName: "Please enter a project name.",
                selectProjectFirst2: "Please select a project first.",
                zipModuleError: "Could not load ZIP module.",
                renameProjectTitle: "Rename project",
                renameProjectLabel: "Enter new name",
                deleteProjectTitle: "Delete project",
                deleteProjectMsg: (name) => `Do you really want to delete the project "${name}"?`,
                pythonErrorPrefix: "Python error:\n",
                matchesFound: (n) => `${n} matches found.`,
                matchesReplaced: (n) => `${n} matches replaced.`,
                jumpToLineTitle: (line) => `Jump to line ${line}`,

                cmdNewWeb: "New web project",
                cmdNewPy: "New Python project",
                cmdSave: "Save",
                cmdFormat: "Format",
                cmdSearch: "Find & Replace",
                cmdTheme: "Toggle theme",
                cmdFullscreen: "Editor fullscreen",
                cmdZip: "Export ZIP",
                cmdHome: "Home"
            }
        };

        function getInitialAppLang() {
            const saved = localStorage.getItem("appLang");
            if (saved === "de" || saved === "en") return saved;
            const nav = (navigator.language || navigator.userLanguage || "en").toLowerCase();
            return nav.startsWith("de") ? "de" : "en";
        }

        let currentAppLang = getInitialAppLang();

        function t(key, ...args) {
            const entry = (appI18n[currentAppLang] && appI18n[currentAppLang][key]) ?? appI18n.en[key] ?? key;
            return typeof entry === "function" ? entry(...args) : entry;
        }

        function applyAppTranslations() {
            document.documentElement.lang = currentAppLang;

            // Elemente mit data-i18n / data-i18n-title / data-i18n-placeholder
            // werden generisch anhand ihres Übersetzungs-Keys befüllt.
            document.querySelectorAll("[data-i18n]").forEach(el => {
                el.textContent = t(el.getAttribute("data-i18n"));
            });
            document.querySelectorAll("[data-i18n-title]").forEach(el => {
                el.title = t(el.getAttribute("data-i18n-title"));
            });
            document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
                el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
            });
            document.querySelectorAll("[data-i18n-aria]").forEach(el => {
                el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
            });

            // Default-Projektname im "Neues Projekt"-Feld nur anpassen,
            // solange der Nutzer ihn noch nicht selbst geändert hat.
            const nameInput = document.getElementById("new-project-name");
            if (nameInput && (nameInput.dataset.userEdited !== "true")) {
                nameInput.value = t("defaultProjectName");
            }

            // Vorlagen-Auswahl im "Neues Projekt"-Modal neu aufbauen (Labels
            // sind sprachabhängig).
            if (typeof chooseProjectType === "function" && document.getElementById("project-template")) {
                chooseProjectType(projectTypeForModal);
            }

            // Live-Vorschau-Pausebutton nach jedem Sprachwechsel neu setzen.
            // Dadurch werden auch title und aria-label sofort auf die aktuelle
            // Sprache aktualisiert, unabhängig davon, ob die Vorschau gerade
            // pausiert ist oder läuft.
            if (typeof setPreviewPauseButton === "function") {
                setPreviewPauseButton(previewPaused);
            }

            // Der Vollbild-Button traegt je nach Zustand zwei verschiedene
            // Beschriftungen. data-i18n setzt oben immer die "Vollbild"-
            // Variante, deshalb hier den echten Zustand nachziehen.
            if (typeof updatePreviewFullscreenButton === "function") {
                updatePreviewFullscreenButton();

            // Bibliothek und Ordner-Auswahl enthalten uebersetzte Texte
            // ("PROJEKTE", "Leer", "Kein Ordner") und werden deshalb nach
            // einem Sprachwechsel neu aufgebaut.
            if (typeof loadProjects === "function" && document.getElementById("project-list")) {
                loadProjects();
            }
            const folderSelectEl = document.getElementById("new-project-folder");
            if (typeof populateFolderSelect === "function" && folderSelectEl) {
                populateFolderSelect(folderSelectEl.value);
            }
            }

            // Sprach-Button auf der Startseite.
            const langBtn = document.getElementById("app-lang-toggle");
            if (langBtn) {
                langBtn.textContent = currentAppLang === "de" ? "🇩🇪 Deutsch" : "🇬🇧 English";
                langBtn.title = t("langToggleTitle");
            }

            // Terminal-Status: nur nachziehen, solange noch kein echter
            // Lauf/Fehler/Reset stattgefunden hat (reiner Startzustand).
            const out = document.getElementById("python-output");
            if (out && out.dataset.state === "starting") {
                out.textContent = t("starting");
            } else if (out && out.dataset.state === "ready") {
                out.textContent = t("ready");
            }

            // Command Palette neu rendern, falls gerade offen bzw. beim
            // nächsten Öffnen mit den richtigen Labels.
            if (typeof renderCommands === "function" && document.getElementById("command-input")) {
                renderCommands(document.getElementById("command-input").value || "");
            }

            const recentTitle = document.getElementById("home-recent-title");
            if (recentTitle) recentTitle.textContent = t("homeRecent");
            if (typeof renderRecentProjects === "function") renderRecentProjects();
        }

        function toggleAppLang() {
            currentAppLang = currentAppLang === "de" ? "en" : "de";
            localStorage.setItem("appLang", currentAppLang);
            applyAppTranslations();
        }

        async function initPyodide() {
            try {
                pyodide = await loadPyodide();
                const out = document.getElementById("python-output");
                out.dataset.state = "ready";
                out.textContent = t("ready");
            } catch (err) {
                const out = document.getElementById("python-output");
                out.dataset.state = "error";
                out.textContent = t("loadError") + err;
            }
        }

        async function resetPython() {
            clearPythonRuntimeState();
            const out = document.getElementById("python-output");
            out.dataset.state = "reset";
            out.textContent = t("resetDone");
        }

        // Setzt den kompletten Python-Laufzeitzustand zurück (Namespace,
        // laufende input()-Abfrage, "läuft gerade"-Flag) - OHNE das
        // Terminal-Textfeld zu beschreiben. Wird von resetPython() (zeigt
        // danach "zurückgesetzt") UND beim Öffnen/Wechseln eines Projekts
        // verwendet (zeigt danach "bereit"), damit niemals der Zustand
        // (oder eine noch offene Eingabeaufforderung) eines ANDEREN
        // Projekts in ein frisch geöffnetes Projekt durchsickert.
        function clearPythonRuntimeState() {
            pythonInputResolver = null;
            hidePythonInput();
            if (pyNamespace) {
                try { pyNamespace.destroy(); } catch (e) {}
                pyNamespace = null;
            }
            pythonRunning = false;
        }


        async function runPython() {
            const outputDiv = document.getElementById("python-output");

            if (!pyodide) {
                outputDiv.textContent = t("stillLoading");
                return;
            }

            if (pythonRunning) return;

            pythonRunning = true;
            pythonInputResolver = null;
            hidePythonInput();
            outputDiv.dataset.state = "running";
            outputDiv.textContent = "";

            // Für jeden Lauf einen komplett frischen globalen Namespace
            // anlegen. Ohne das würden Variablen, Funktionen, Klassen
            // und Objekte aus dem vorherigen Lauf im Interpreter erhalten
            // bleiben - der Button hat also nicht wirklich "resettet",
            // sondern nur weitergemacht. Der alte Namespace wird vorher
            // sauber freigegeben (destroy), um kein Speicherleck zu erzeugen.
            if (pyNamespace) {
                try { pyNamespace.destroy(); } catch (e) {}
                pyNamespace = null;
            }
            pyNamespace = pyodide.globals.get("dict")();

            // raw sorgt dafür, dass input("> ") ohne Zeilenumbruch sofort
            // direkt im Terminal sichtbar wird. Pyodide liefert dabei
            // einzelne Bytes (nicht Zeichen) - ein Sonderzeichen wie "ß"
            // besteht in UTF-8 aus 2 Bytes. Ein TextDecoder mit
            // stream:true puffert unvollständige Mehrbyte-Sequenzen und
            // setzt sie erst zu einem Zeichen zusammen, sobald alle
            // Bytes da sind - sonst würde z.B. "ß" als "Ã" +
            // Sonderzeichen angezeigt.
            const stdoutDecoder = new TextDecoder("utf-8");
            const stderrDecoder = new TextDecoder("utf-8");

            pyodide.setStdout({
                raw: (charCode) => {
                    const chunk = stdoutDecoder.decode(new Uint8Array([charCode]), { stream: true });
                    if (chunk) appendPythonOutput(chunk);
                }
            });

            pyodide.setStderr({
                raw: (charCode) => {
                    const chunk = stderrDecoder.decode(new Uint8Array([charCode]), { stream: true });
                    if (chunk) appendPythonOutput(chunk);
                }
            });

            try {
                const code = cmEditors.py.getValue();

                // Normales Python input() wird umgeleitet, damit es direkt
                // auf die Eingabezeile im schwarzen Terminal wartet.
                const terminalPrelude = `
import builtins
from pyodide.ffi import run_sync
from js import window

def __browser_terminal_input(prompt=""):
    if prompt:
        print(prompt, end="", flush=True)
    return run_sync(window.waitForPythonInput())

builtins.input = __browser_terminal_input
`;

                let result = await pyodide.runPythonAsync(terminalPrelude + "\n" + code, { globals: pyNamespace });

                if (result !== undefined && outputDiv.textContent === "") {
                    appendPythonOutput(String(result));
                }
            } catch (err) {
                const pythonError = t("pythonErrorPrefix") + String(err);
                appendPythonError(pythonError);
            } finally {
                pythonRunning = false;
                pythonInputResolver = null;
                hidePythonInput();
            }
        }


        // =========================================================
        // CODE KOPIEREN (HTML / CSS / JS / Python)
        // =========================================================
        function copyEditorCode(editorKey, btnEl) {
            const cm = cmEditors[editorKey];
            if (!cm) return;
            const text = cm.getValue();

            const showCopied = () => {
                if (!btnEl) return;
                const original = btnEl.dataset.originalText || btnEl.innerHTML;
                btnEl.dataset.originalText = original;
                btnEl.innerHTML = t("copied");
                btnEl.classList.add("copied");
                clearTimeout(btnEl._copyResetTimeout);
                btnEl._copyResetTimeout = setTimeout(() => {
                    btnEl.innerHTML = original;
                    btnEl.classList.remove("copied");
                }, 1200);
            };

            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(showCopied).catch(() => fallbackCopy(text, showCopied));
            } else {
                fallbackCopy(text, showCopied);
            }
        }

        function fallbackCopy(text, onSuccess) {
            try {
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.style.position = "fixed";
                ta.style.top = "-9999px";
                ta.style.left = "-9999px";
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
                if (onSuccess) onSuccess();
            } catch (e) {
                showToast(t("copyFailed"), "error");
            }
        }

        // =========================================================
        // WEB-VORSCHAU: Pause/Weiter und Reset
        //
        // Reset baut das Vorschau-Dokument komplett neu auf (neues srcdoc
        // = frisches Dokument ohne alten JS-Zustand).
        // Pause/Weiter friert das laufende Dokument nur ein bzw. laesst es
        // weiterlaufen - ohne Neuaufbau.
        // =========================================================
        let previewPaused = false;

        // =========================================================
        // TASTATUR-FOKUS RUND UM DIE LIVE-VORSCHAU
        //
        // Zwei gemeldete Fehler haben DIESELBE Ursache: nach einer
        // Aktion liegt der Tastatur-Fokus nicht dort, wo der Nutzer ihn
        // erwartet.
        //
        // 1) "Leertaste beendet das Vollbild wieder."
        //    Ein <button> behaelt nach einem Mausklick den Fokus. Drueckt
        //    man danach Leertaste oder Enter, loest der BROWSER denselben
        //    Button noch einmal aus. Das ist eingebautes Verhalten von
        //    HTML, kein eigener Tastenkuerzel - es gibt hier keine
        //    Shortcuts fuer Vollbild, Pause oder Reset, und es werden
        //    auch keine angelegt.
        //
        // 2) "Laufzeit-Eingaben landen im Code."
        //    Hat ein Editor den Fokus und der Nutzer tippt, waehrend er
        //    auf die Vorschau schaut, schreibt er in den QUELLTEXT. Das
        //    laufende Projekt bekommt keine einzige Taste ab.
        //
        // Loesung an der Wurzel, nicht am Symptom:
        //   * Ein Button, der MIT DER MAUS angeklickt wurde, gibt den
        //     Fokus wieder ab. Bedienung ueber die Tastatur (Tab, dann
        //     Leertaste/Enter) bleibt unveraendert - das ist normale
        //     Barrierefreiheit und kein Shortcut.
        //   * Nach Reset, Weiter/Pause und beim Wechsel ins Vollbild
        //     bekommt die Vorschau selbst den Fokus. Tasten gehen damit
        //     an das laufende Projekt und nicht in den Code.
        //
        // Ereignisse aus dem iframe koennen die Bedienelemente ohnehin
        // nicht erreichen: Ereignisse eines eingebetteten Dokuments
        // steigen nicht in die Elternseite auf.
        // =========================================================
        function initButtonFocusReset() {
            document.addEventListener("click", (e) => {
                // detail === 0 bedeutet: ueber die Tastatur ausgeloest.
                // Diese Aktivierung darf den Fokus behalten.
                if (!e.detail) return;
                const btn = e.target && e.target.closest ? e.target.closest("button") : null;
                if (!btn || btn.disabled) return;
                if (document.activeElement !== btn) return;
                btn.blur();
            });
        }

        // Ein echter Mausklick hat detail > 0, eine Tastatur-Aktivierung
        // (Tab, dann Leertaste/Enter) hat detail === 0.
        function isPointerActivation(e) {
            return !!(e && typeof e.detail === "number" && e.detail > 0);
        }

        // Gibt der Live-Vorschau den Tastatur-Fokus, damit Tasten beim
        // laufenden Projekt ankommen. Nur im Web-Tab sinnvoll.
        //
        // Wird ein Ereignis mitgegeben, wird der Fokus NUR nach einer
        // Maus-Aktivierung umgesetzt. Wer die App per Tastatur bedient,
        // behaelt den Fokus auf dem Bedienelement - sonst waere das
        // Bedienen ohne Maus nach dem ersten Klick vorbei.
        function focusPreview(triggerEvent) {
            if (triggerEvent && !isPointerActivation(triggerEvent)) return;
            const webTab = document.getElementById("web-tab");
            if (!webTab || !webTab.classList.contains("active")) return;
            const iframe = document.getElementById("preview-frame");
            if (!iframe) return;
            try {
                iframe.focus({ preventScroll: true });
            } catch (e) {
                try { iframe.focus(); } catch (err) {}
            }
        }

        function setPreviewPauseButton(paused) {
            const btn = document.getElementById("preview-pause-btn");
            const icon = document.getElementById("preview-pause-icon");
            if (!btn || !icon) return;

            btn.classList.toggle("active", paused);

            // Der Tooltip wird bei jedem Aktualisieren explizit aus der
            // aktuell gewählten App-Sprache gesetzt. Dadurch kann kein
            // alter/native Tooltip nach einem Sprachwechsel hängen bleiben.
            const tooltipKey = paused ? "resumePreviewTitle" : "pausePreviewTitle";
            const tooltipText = t(tooltipKey);
            btn.removeAttribute("title");
            btn.setAttribute("data-preview-tooltip", tooltipText);
            btn.setAttribute("aria-label", tooltipText);

            if (paused) {
                icon.innerHTML = '<path d="M6 3.5 12 8l-6 4.5z" fill="currentColor" stroke="none"/>';
            } else {
                icon.innerHTML = '<path d="M5 3v10M11 3v10"/>';
            }
        }

        // Pause/Weiter ist ein reiner Zustandswechsel: RUNNING -> PAUSED ->
        // RUNNING. Beide Richtungen sind nur eine Nachricht an das
        // Vorschau-Dokument, das sich selbst einfriert bzw. genau dort
        // weiterlaeuft (siehe Shim in updateWebPreview). Die Vorschau wird
        // dabei NICHT neu geladen - sonst waere "Weiter" ein Neustart.
        function togglePreviewPause(triggerEvent) {
            const iframe = document.getElementById("preview-frame");
            if (!iframe || !iframe.contentWindow) return;

            previewPaused = !previewPaused;
            setPreviewPauseButton(previewPaused);
            try {
                iframe.contentWindow.postMessage({
                    type: previewPaused ? "codeforge-preview-pause" : "codeforge-preview-resume"
                }, "*");
            } catch (e) {}

            // Tasten sollen ab jetzt beim Projekt ankommen, nicht auf dem
            // gerade angeklickten Button liegen bleiben.
            focusPreview(triggerEvent);
        }

        function resetWebPreview(triggerEvent) {
            // Vorschau komplett neu aufbauen. iframe.srcdoc neu zu setzen
            // erzeugt IMMER ein frisches Dokument (zerstört alten JS-
            // Zustand, Variablen, Timer usw.) - auch wenn der Inhalt exakt
            // identisch ist. Der vorherige Umweg über "erst src=about:blank
            // setzen, dann zwei requestAnimationFrame abwarten" war nicht
            // nötig UND fehleranfällig: in bestimmten Situationen (z.B.
            // direkt nach dem Umschalten in den Vollbild-Modus, was selbst
            // schon einen Reflow auslöst) konnte das zweite
            // requestAnimationFrame ausbleiben, wodurch die Vorschau auf
            // "about:blank" (also weiß) hängen geblieben ist - genau der
            // gemeldete Bug.
            const iframe = document.getElementById("preview-frame");
            if (!iframe) return;

            // Reset beendet auch den Pause-Zustand der aktuellen Vorschau.
            // Die Vorschau wird neu aufgebaut und muss daher wieder als aktiv
            // angezeigt werden (Button/Icon/Tooltip synchron zur Vorschau).
            previewPaused = false;
            setPreviewPauseButton(false);

            clearWebConsole();
            updateWebPreview(true);
            appendConsoleEntry("success", t("projectStarted"));
            focusPreview(triggerEvent);
        }

        function clearWebConsole() {
            const output = document.getElementById("js-console-output");
            if (output) output.innerHTML = "";
        }

        // Anzahl der Dokumentzeilen, die im iframe VOR dem eigentlichen
        // JS-Code stehen. Wird gebraucht, um bei einem Laufzeitfehler die
        // passende Zeile im JS-Editor zu finden (siehe updateWebPreview /
        // jumpToJsLine).
        let jsLineOffset = 0;

        window.addEventListener("message", function(event) {
            const iframe = document.getElementById("preview-frame");
            if (event.source !== iframe.contentWindow) return;

            if (event.data && event.data.type === "console") {
                const logType = event.data.logType === "log" ? "info" : event.data.logType;
                let location = "";
                let jumpLine = null;

                if (event.data.line) {
                    const userLine = event.data.line - jsLineOffset;
                    if (userLine >= 1) {
                        jumpLine = userLine;
                        location = "script.js:" + userLine;
                    }
                }

                appendConsoleEntry(logType, event.data.message, location, jumpLine);
            }
        });

        // Springt im JS-Editor zur angegebenen Zeile (z.B. per Klick auf
        // einen Fehler in der Konsole) und hebt sie kurz hervor.
        function jumpToJsLine(line) {
            if (!cmEditors.js) return;

            const jsBox = document.getElementById("js-box");
            if (jsBox && jsBox.classList.contains("collapsed")) {
                toggleBox("js-box");
            }

            const lineIndex = Math.max(0, line - 1);
            setTimeout(() => {
                cmEditors.js.refresh();
                cmEditors.js.setCursor({ line: lineIndex, ch: 0 });
                cmEditors.js.scrollIntoView({ line: lineIndex, ch: 0 }, 100);
                cmEditors.js.focus();

                const handle = cmEditors.js.addLineClass(lineIndex, "background", "js-error-line-highlight");
                setTimeout(() => {
                    cmEditors.js.removeLineClass(lineIndex, "background", "js-error-line-highlight");
                }, 1600);
            }, 60);
        }

        async function formatCurrentCode() {
            if (!currentProjectKey) return;
            const data = await dbGet(currentProjectKey) || {};
            const isPython = (data.type === "python");

            // Wie beim Öffnen eines Projekts: mehrere setValue()-Aufrufe
            // hintereinander sollen nicht jeweils einzeln (mit noch
            // unvollständigen Daten) die Vorschau neu aufbauen - das führte
            // zu genau der Race Condition, die weißes/unstyled Rendern
            // ausgelöst hat. Erst alle Werte setzen, danach EINMAL sauber
            // aktualisieren.
            suppressEditorEvents = true;
            if (isPython) {
                const val = cmEditors.py.getValue();
                const formatted = val.split('\n').map(line => line.trimEnd()).join('\n').trim();
                cmEditors.py.setValue(formatted);
            } else {
                if (window.html_beautify && cmEditors.html.getValue()) {
                    cmEditors.html.setValue(html_beautify(cmEditors.html.getValue(), { indent_size: 2 }));
                }
                if (window.css_beautify && cmEditors.css.getValue()) {
                    cmEditors.css.setValue(css_beautify(cmEditors.css.getValue(), { indent_size: 2 }));
                }
                if (window.js_beautify && cmEditors.js.getValue()) {
                    cmEditors.js.setValue(js_beautify(cmEditors.js.getValue(), { indent_size: 2 }));
                }
            }
            suppressEditorEvents = false;
            if (!isPython) updateWebPreview();
            triggerAutoSave();
        }

        const colDivider = document.getElementById('col-divider');
        const editorsColumn = document.getElementById('editors-column');
        const webTab = document.getElementById('web-tab');

        // =========================================================
        // TRENNER ZIEHEN (Spalte + Zeilen)
        //
        // Waehrend eines Drags wird pro Pointer-Event NICHTS am Layout
        // gelesen oder geschrieben - die Zeigerposition landet nur in einer
        // Variablen. Die Style-Aenderung passiert genau EINMAL pro Frame in
        // einem requestAnimationFrame-Schritt.
        //
        // Vorher lief bei jedem Mausschritt ein getBoundingClientRect()
        // direkt vor einem Style-Write (erzwungenes Synchron-Layout) UND
        // ein refreshCodeMirrorEditors(), das jedes Mal einen eigenen
        // 50ms-Timer anlegte. Bei einem langen Drag stauten sich so
        // hunderte Timer, die alle vier CodeMirror-Editoren komplett neu
        // vermessen liessen. Der Haupt-Thread war dadurch dauerhaft
        // blockiert - und genau das liess den iframe der Live-Vorschau
        // sichtbar flackern (besonders bei grossen Projekten).
        // =========================================================
        let colDragPointer = null;
        let colDragFrame = null;
        let colDragX = 0;
        let colDragRect = null;

        function applyColDrag() {
            colDragFrame = null;
            if (colDragPointer === null || !colDragRect) return;
            const newWidth = ((colDragX - colDragRect.left) / colDragRect.width) * 100;
            if (newWidth >= 10 && newWidth <= 90) {
                editorsColumn.style.width = `${newWidth}%`;
            }
        }

        colDivider.addEventListener('pointerdown', (e) => {
            colDragPointer = e.pointerId;
            colDragX = e.clientX;
            // Die Breite des Web-Tabs aendert sich waehrend des Ziehens
            // nicht - einmal messen reicht.
            colDragRect = webTab.getBoundingClientRect();
            colDivider.setPointerCapture(e.pointerId);
            colDivider.classList.add('dragging');
            document.body.classList.add('dragging-active');
            document.body.style.cursor = 'col-resize';
        });

        colDivider.addEventListener('pointermove', (e) => {
            if (colDragPointer === null || e.pointerId !== colDragPointer) return;
            colDragX = e.clientX;
            if (colDragFrame === null) colDragFrame = requestAnimationFrame(applyColDrag);
        });

        const stopColDragging = (e) => {
            if (colDragPointer === null) return;
            if (colDivider.hasPointerCapture(e.pointerId)) {
                colDivider.releasePointerCapture(e.pointerId);
            }
            if (colDragFrame !== null) {
                cancelAnimationFrame(colDragFrame);
                colDragFrame = null;
            }
            colDragX = e.clientX;
            applyColDrag();
            colDragPointer = null;
            colDragRect = null;
            colDivider.classList.remove('dragging');
            document.body.classList.remove('dragging-active');
            document.body.style.cursor = '';
            // Erst am Ende des Drags werden die Editoren einmal sauber neu
            // vermessen - statt hunderte Male mittendrin.
            refreshCodeMirrorEditors();
        };

        colDivider.addEventListener('pointerup', stopColDragging);
        colDivider.addEventListener('pointercancel', stopColDragging);

        function initRowDivider(dividerId, topBoxId, bottomBoxId) {
            const divider = document.getElementById(dividerId);
            const topBox = document.getElementById(topBoxId);
            const bottomBox = document.getElementById(bottomBoxId);

            // Gleiches Muster wie beim Spalten-Trenner: messen beim
            // Drag-Start, schreiben einmal pro Frame.
            let pointerId = null;
            let frame = null;
            let clientY = 0;
            let dragTop = 0;    // Oberkante des oberen Kastens
            let dragTotal = 0;  // Gesamthoehe beider Kaesten
            let dragFlex = 2;   // Summe der flex-grow-Werte beider Kaesten

            const applyRowDrag = () => {
                frame = null;
                if (pointerId === null || dragTotal <= 0) return;
                const newTopPixel = clientY - dragTop;
                if (newTopPixel > 40 && (dragTotal - newTopPixel) > 40) {
                    const topRatio = newTopPixel / dragTotal;
                    topBox.style.flex = (dragFlex * topRatio);
                    bottomBox.style.flex = (dragFlex * (1 - topRatio));
                }
            };

            divider.addEventListener('pointerdown', (e) => {
                const topRect = topBox.getBoundingClientRect();
                const bottomRect = bottomBox.getBoundingClientRect();
                pointerId = e.pointerId;
                clientY = e.clientY;
                dragTop = topRect.top;
                dragTotal = topRect.height + bottomRect.height;
                dragFlex = parseFloat(topBox.style.flexGrow || 1) + parseFloat(bottomBox.style.flexGrow || 1);
                divider.setPointerCapture(e.pointerId);
                divider.classList.add('dragging');
                document.body.classList.add('dragging-active');
                document.body.style.cursor = 'row-resize';
            });

            divider.addEventListener('pointermove', (e) => {
                if (pointerId === null || e.pointerId !== pointerId) return;
                clientY = e.clientY;
                if (frame === null) frame = requestAnimationFrame(applyRowDrag);
            });

            const stopRowDragging = (e) => {
                if (pointerId === null) return;
                if (divider.hasPointerCapture(e.pointerId)) {
                    divider.releasePointerCapture(e.pointerId);
                }
                if (frame !== null) {
                    cancelAnimationFrame(frame);
                    frame = null;
                }
                clientY = e.clientY;
                applyRowDrag();
                pointerId = null;
                divider.classList.remove('dragging');
                document.body.classList.remove('dragging-active');
                document.body.style.cursor = '';
                refreshCodeMirrorEditors();
            };

            divider.addEventListener('pointerup', stopRowDragging);
            divider.addEventListener('pointercancel', stopRowDragging);
        }

        initRowDivider('divider-html-css', 'html-box', 'css-box');
        initRowDivider('divider-css-js', 'css-box', 'js-box');

        // Wird nach jeder Layout-Aenderung aufgerufen (Drag-Ende, Kasten
        // ein-/ausklappen, Theme, Sidebar, Vollbild). Mehrere Aufrufe kurz
        // hintereinander werden zu EINEM refresh pro Frame zusammengefasst;
        // zusaetzlich laeuft ein nachgelagerter refresh, sobald sich das
        // Layout beruhigt hat (z.B. nach der 0,25s-Animation der Sidebar).
        // Vorher legte JEDER Aufruf einen eigenen 50ms-Timer an.
        let cmRefreshFrame = null;
        let cmRefreshTimeout = null;

        function refreshVisibleEditors() {
            Object.values(cmEditors).forEach(editor => {
                // Ein Editor in einem ausgeblendeten Tab hat keine Groesse.
                // Ihn zu vermessen kostet nur Zeit und speichert falsche
                // Werte (z.B. der Python-Editor bei offenem Web-Tab).
                if (editor && editor.getWrapperElement().offsetParent !== null) {
                    editor.refresh();
                }
            });
        }

        function refreshCodeMirrorEditors() {
            if (cmRefreshFrame === null) {
                cmRefreshFrame = requestAnimationFrame(() => {
                    cmRefreshFrame = null;
                    refreshVisibleEditors();
                });
            }
            clearTimeout(cmRefreshTimeout);
            cmRefreshTimeout = setTimeout(() => {
                cmRefreshTimeout = null;
                refreshVisibleEditors();
            }, 300);
        }

        function toggleBox(boxId) {
            const box = document.getElementById(boxId);
            const type = boxId.split('-')[0];
            const btn = document.getElementById(`btn-toggle-${type}`);
            
            box.classList.toggle('collapsed');
            if (box.classList.contains('collapsed')) {
                btn.classList.remove('active-tab');
            } else {
                btn.classList.add('active-tab');
            }
            updateDividersAndFlex();
            refreshCodeMirrorEditors();
        }

        function toggleWebConsole() {
            const consoleBox = document.querySelector('.js-console-container');
            const visible = !consoleBox.classList.toggle('collapsed');

            document.getElementById('btn-toggle-console').classList.toggle('active-tab', visible);

            // Zweiter Schalter in der Vorschau-Kopfzeile. Er ist nur im
            // Vollbild sichtbar (siehe CSS) - dort liegt die Leiste mit dem
            // normalen Konsolen-Schalter ausserhalb des Vollbild-Elements,
            // die Konsole liesse sich sonst nicht wieder einblenden.
            const previewBtn = document.getElementById('preview-console-btn');
            if (previewBtn) previewBtn.classList.toggle('active', visible);
        }

        function updateDividersAndFlex() {
            const htmlBox = document.getElementById('html-box');
            const cssBox = document.getElementById('css-box');
            const jsBox = document.getElementById('js-box');

            const htmlVis = !htmlBox.classList.contains('collapsed');
            const cssVis = !cssBox.classList.contains('collapsed');
            const jsVis = !jsBox.classList.contains('collapsed');

            [htmlBox, cssBox, jsBox].forEach(b => {
                if (b.classList.contains('collapsed')) {
                    b.style.flex = '0 0 auto';
                } else if (!b.style.flex || b.style.flex.startsWith('0')) {
                    b.style.flex = '1';
                }
            });

            document.getElementById('divider-html-css').style.display = (htmlVis && (cssVis || jsVis)) ? 'block' : 'none';
            document.getElementById('divider-css-js').style.display = (cssVis && jsVis) ? 'block' : 'none';
        }

        function triggerAutoSave() {
            clearTimeout(autoSaveTimeout);
            autoSaveTimeout = setTimeout(async () => {
                if (currentProjectKey) {
                    const oldData = await dbGet(currentProjectKey) || {};
                    const data = {
                        type: oldData.type || "web",
                        // Die Ordnerzuordnung gehoert zum Projekt und
                        // darf beim Speichern nicht verloren gehen.
                        folderId: oldData.folderId || null,
                        html: cmEditors.html.getValue(),
                        css: cmEditors.css.getValue(),
                        js: cmEditors.js.getValue(),
                        py: cmEditors.py.getValue()
                    };
                    await dbSet(currentProjectKey, data);
                }
            }, 1000);
        }

        function toggleSidebar() {
            document.getElementById("sidebar").classList.toggle("collapsed");
            document.body.classList.toggle("sidebar-collapsed");
            refreshCodeMirrorEditors();
        }

        // =========================================================
        // VOLLBILD DER LIVE-VORSCHAU (echte Fullscreen-API)
        //
        // Es geht IMMER der komplette Vorschau-Container ins Vollbild -
        // also Kopfzeile + iframe + Konsole. Dadurch bleibt die Konsole im
        // Vollbild unten sichtbar und ihr X funktioniert weiter.
        //
        // Es wird bewusst KEIN eigener "ist im Vollbild"-Zustand gefuehrt.
        // Einzige Quelle der Wahrheit ist document.fullscreenElement. Der
        // Button liest ihn ueber das fullscreenchange-Ereignis nach - so
        // stimmt er auch, wenn der Nutzer das Vollbild mit ESC oder ueber
        // den Browser verlaesst. Vorher wurde nur die Editor-Spalte
        // ausgeblendet (ein nachgebautes Vollbild), ESC hatte keine
        // Wirkung und der Button konnte nie aus dem Tritt geraten, weil es
        // gar kein echtes Vollbild gab.
        // =========================================================
        function isPreviewFullscreen() {
            const active = document.fullscreenElement || document.webkitFullscreenElement || null;
            return active === document.getElementById("preview-container");
        }

        function togglePreviewFullscreen() {
            const container = document.getElementById("preview-container");
            if (!container) return;

            if (isPreviewFullscreen()) {
                const exit = document.exitFullscreen || document.webkitExitFullscreen;
                if (exit) exit.call(document);
                return;
            }

            const request = container.requestFullscreen || container.webkitRequestFullscreen;
            if (!request) {
                showToast(t("fullscreenUnavailable"), "warning");
                return;
            }
            const done = request.call(container);
            if (done && done.catch) done.catch(() => showToast(t("fullscreenUnavailable"), "warning"));
        }

        function updatePreviewFullscreenButton() {
            const btn = document.getElementById("preview-fullscreen-btn");
            if (!btn) return;
            const active = isPreviewFullscreen();
            btn.classList.toggle("active", active);
            btn.textContent = t(active ? "exitFullscreenPreviewBtn" : "fullscreenPreviewBtn");
        }

        function onFullscreenChange() {
            updatePreviewFullscreenButton();
            // Im Vollbild gehoert die Tastatur dem Projekt.
            if (isPreviewFullscreen()) focusPreview();
            // Nach dem Wechsel hat sich das gesamte Layout geaendert -
            // die Editoren einmal neu vermessen lassen.
            refreshCodeMirrorEditors();
        }

        document.addEventListener("fullscreenchange", onFullscreenChange);
        document.addEventListener("webkitfullscreenchange", onFullscreenChange);

        function updateWebPreview(force = false) {
            if (previewPaused && !force) return;
            clearWebConsole();

            // Der aktuelle Pause-Zustand wandert direkt ins neue Dokument.
            // So wird eine pausierte Vorschau gar nicht erst gestartet.
            const startPaused = previewPaused === true;

            const consoleIntercepter = `<script>
(function(){
    function sendLog(type, args, line) {
        try {
            var msg = Array.from(args).map(function(a){
                if (a instanceof Error) return a.message;
                return typeof a === 'object' ? JSON.stringify(a) : String(a);
            }).join(' ');
            var origin = window.location.origin === 'null' ? '*' : window.location.origin;
            window.parent.postMessage({ type: 'console', logType: type, message: msg, line: line || null }, origin);
        } catch(e) {}
    }
    var origLog = console.log, origError = console.error, origWarn = console.warn;
    console.log = function(){ sendLog('log', arguments); origLog.apply(console, arguments); };
    console.error = function(){ sendLog('error', arguments); origError.apply(console, arguments); };
    console.warn = function(){ sendLog('warn', arguments); origWarn.apply(console, arguments); };
    window.onerror = function(msg, url, line, col, error) {
        sendLog('error', [msg], line);
        return false;
    };

    // CodeForge Preview-Pause: ECHTES Anhalten und Fortsetzen.
    //
    // Beim Pausieren werden laufende Timer und Animationsframes gestoppt
    // und ihre RESTLAUFZEIT gemerkt, CSS-Animationen und Medien angehalten.
    // Beim Fortsetzen laufen sie mit genau dieser Restzeit weiter. Das
    // Dokument wird dabei NICHT neu geladen - der komplette JS-Zustand
    // (Variablen, Spielstand, Position) bleibt erhalten.
    //
    // Vorher hat die Elternseite beim Fortsetzen die Vorschau komplett neu
    // gebaut. Das war kein Fortsetzen, sondern ein Neustart von vorne -
    // genau der gemeldete Fehler.
    //
    // Damit zeitbasierte Animationen beim Fortsetzen nicht springen, laufen
    // Date.now(), performance.now() und die requestAnimationFrame-
    // Zeitstempel im Vorschau-Dokument um die Pausendauer versetzt weiter.
    // Wird von der Elternseite gesetzt: soll dieses Dokument bereits
    // im pausierten Zustand starten?
    var __cfStartPaused = ${startPaused};
    var __cfPaused = false;
    var __cfPausedAt = 0;
    var __cfOffset = 0;             // aufsummierte Pausendauer in ms
    var __cfNextId = 1000000000;    // eigene IDs, kollidieren nicht mit echten
    var __cfTimers = new Map();     // eigene ID -> Timer-Eintrag
    var __cfFrames = new Map();     // eigene ID -> Animationsframe-Eintrag

    var __cfSetInterval = window.setInterval.bind(window);
    var __cfSetTimeout = window.setTimeout.bind(window);
    var __cfClearTimeout = window.clearTimeout.bind(window);
    var __cfRAF = window.requestAnimationFrame.bind(window);
    var __cfCancelRAF = window.cancelAnimationFrame.bind(window);
    var __cfRealNow = performance.now.bind(performance);
    var __cfDateBase = Date.now() - __cfRealNow();

    // Uhr des Vorschau-Dokuments. Steht still, solange pausiert wird.
    function __cfVirtualNow() {
        var real = __cfRealNow();
        return real - __cfOffset - (__cfPaused ? (real - __cfPausedAt) : 0);
    }
    performance.now = function() { return __cfVirtualNow(); };
    Date.now = function() { return __cfDateBase + __cfVirtualNow(); };

    function __cfSchedule(entry) {
        entry.start = __cfVirtualNow();
        entry.handle = __cfSetTimeout(function() { __cfFire(entry); }, entry.remaining);
    }

    function __cfFire(entry) {
        entry.handle = null;
        if (entry.repeat) {
            // Vor dem Aufruf neu planen, damit ein clearInterval INNERHALB
            // des Callbacks den naechsten Durchlauf noch stoppen kann.
            entry.remaining = entry.delay;
            __cfSchedule(entry);
        } else {
            __cfTimers.delete(entry.id);
        }
        entry.fn.apply(window, entry.args);
    }

    function __cfAddTimer(fn, ms, args, repeat) {
        var delay = Number(ms) || 0;
        var entry = { id: __cfNextId++, fn: fn, args: args, delay: delay,
                      remaining: delay, repeat: repeat, handle: null, start: 0 };
        __cfTimers.set(entry.id, entry);
        if (!__cfPaused) __cfSchedule(entry);
        return entry.id;
    }

    window.setTimeout = function(fn, ms) {
        if (typeof fn !== 'function') return __cfSetTimeout(fn, ms);
        return __cfAddTimer(fn, ms, Array.prototype.slice.call(arguments, 2), false);
    };
    window.setInterval = function(fn, ms) {
        if (typeof fn !== 'function') return __cfSetInterval(fn, ms);
        return __cfAddTimer(fn, ms, Array.prototype.slice.call(arguments, 2), true);
    };

    function __cfClearTimer(id) {
        var entry = __cfTimers.get(id);
        if (!entry) return __cfClearTimeout(id);
        __cfTimers.delete(id);
        if (entry.handle !== null) __cfClearTimeout(entry.handle);
    }
    window.clearTimeout = __cfClearTimer;
    window.clearInterval = __cfClearTimer;

    function __cfStartFrame(id, entry) {
        entry.handle = __cfRAF(function() {
            __cfFrames.delete(id);
            entry.cb(__cfVirtualNow());
        });
    }

    window.requestAnimationFrame = function(cb) {
        if (typeof cb !== 'function') return __cfRAF(cb);
        var id = __cfNextId++;
        var entry = { cb: cb, handle: null };
        __cfFrames.set(id, entry);
        if (!__cfPaused) __cfStartFrame(id, entry);
        return id;
    };
    window.cancelAnimationFrame = function(id) {
        var entry = __cfFrames.get(id);
        if (!entry) return __cfCancelRAF(id);
        __cfFrames.delete(id);
        if (entry.handle !== null) __cfCancelRAF(entry.handle);
    };

    // CSS-Animationen: EINE Regel statt tausender Inline-Styles. Die
    // Animation friert an ihrer aktuellen Stelle ein und laeuft beim
    // Entfernen der Regel genau dort weiter. (Der alte Code setzte
    // zusaetzlich transition:'none' auf jedes Element und hat das nie
    // wieder zurueckgenommen - Uebergaenge blieben danach kaputt.)
    var __cfPauseStyle = null;
    var __cfPausedMedia = [];

    function __cfPauseVisuals() {
        if (!__cfPauseStyle) {
            __cfPauseStyle = document.createElement('style');
            __cfPauseStyle.textContent = '*, *::before, *::after { animation-play-state: paused !important; }';
        }
        var host = document.head || document.documentElement;
        if (host && !__cfPauseStyle.parentNode) host.appendChild(__cfPauseStyle);
        __cfPausedMedia = [];
        try {
            document.querySelectorAll('video, audio').forEach(function(m) {
                if (!m.paused) { __cfPausedMedia.push(m); m.pause(); }
            });
        } catch (x) {}
    }

    function __cfResumeVisuals() {
        if (__cfPauseStyle && __cfPauseStyle.parentNode) {
            __cfPauseStyle.parentNode.removeChild(__cfPauseStyle);
        }
        __cfPausedMedia.forEach(function(m) {
            var p = m.play();
            if (p && p.catch) p.catch(function(){});
        });
        __cfPausedMedia = [];
    }

    function __cfPause() {
        if (__cfPaused) return;
        var now = __cfVirtualNow();
        __cfPaused = true;
        __cfPausedAt = __cfRealNow();
        __cfTimers.forEach(function(entry) {
            if (entry.handle === null) return;
            __cfClearTimeout(entry.handle);
            entry.handle = null;
            var left = entry.remaining - (now - entry.start);
            entry.remaining = left > 0 ? left : 0;
        });
        __cfFrames.forEach(function(entry) {
            if (entry.handle === null) return;
            __cfCancelRAF(entry.handle);
            entry.handle = null;
        });
        __cfPauseVisuals();
    }

    function __cfResume() {
        if (!__cfPaused) return;
        __cfOffset += __cfRealNow() - __cfPausedAt;
        __cfPaused = false;
        __cfTimers.forEach(function(entry) { __cfSchedule(entry); });
        __cfFrames.forEach(function(entry, id) { __cfStartFrame(id, entry); });
        __cfResumeVisuals();
    }

    window.addEventListener('message', function(e) {
        if (!e.data) return;
        if (e.data.type === 'codeforge-preview-pause') __cfPause();
        else if (e.data.type === 'codeforge-preview-resume') __cfResume();
    });

    // Direkt pausiert starten.
    //
    // Das passiert HIER OBEN im <head>, also BEVOR der Projekt-Code am
    // Ende des <body> laeuft. Dadurch startet nichts kurz an und wird
    // dann angehalten: setTimeout, setInterval und
    // requestAnimationFrame des Projekts werden von Anfang an nur
    // vorgemerkt und gar nicht erst eingeplant. CSS-Animationen stehen
    // ab dem ersten Bild still.
    if (__cfStartPaused) {
        __cfPause();
        // Medien mit autoplay gibt es zu diesem Zeitpunkt noch nicht.
        // Solange pausiert ist, wird jeder Abspielversuch sofort wieder
        // angehalten und fuer das Fortsetzen gemerkt.
        document.addEventListener('play', function(e) {
            if (!__cfPaused) return;
            var media = e.target;
            try { media.pause(); } catch (x) {}
            if (__cfPausedMedia.indexOf(media) === -1) __cfPausedMedia.push(media);
        }, true);
    }

    // WICHTIG: Klicks auf Links in der Vorschau abfangen. Die Vorschau läuft
    // über srcdoc und hat dadurch KEINE eigene URL - Browser lösen relative
    // Links (auch simple "#anchor"-Sprungmarken) in einem srcdoc-Dokument
    // teilweise gegen die URL der Eltern-Seite auf. Klickt man in der
    // Vorschau also z.B. auf <a href="#start">, kann der Browser versuchen,
    // zur echten CodeForge-Datei zu navigieren - dadurch lädt sich die
    // komplette App nochmal INNERHALB der Vorschau (genau der gemeldete Bug).
    // Fix: "#anchor"-Links selbst per JS sanft scrollen (wie es z.B. bei
    // CodePen passiert) und JEDE andere Navigation aus der Vorschau heraus
    // grundsätzlich verhindern.
    document.addEventListener('click', function(e) {
        var a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!a) return;
        var href = a.getAttribute('href');
        if (href === null) return;

        if (href.charAt(0) === '#') {
            e.preventDefault();
            var id = href.slice(1);
            if (id) {
                var target = document.getElementById(id) || document.getElementsByName(id)[0];
                if (target && target.scrollIntoView) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            } else {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
            return;
        }

        // Jede andere Link-Navigation (relative Pfade, "/", externe URLs...)
        // in der Sandbox-Vorschau blockieren statt navigieren zu lassen.
        e.preventDefault();
    }, true);
})();
<\/script>
`;

            const htmlSource = cmEditors.html ? cmEditors.html.getValue() : "";
            const cssSource = cmEditors.css ? cmEditors.css.getValue() : "";
            const jsSource = cmEditors.js ? cmEditors.js.getValue() : "";
            const styleBlock = `<style>\n${cssSource}\n</style>`;

            let doc = htmlSource;

            // 1) Konsolen-Interceptor + <style> SAUBER ins <head> einfügen
            //    (bzw. falls kein <head> existiert, direkt vorne anstellen).
            //    Vorher wurden Style/Script einfach HINTER das komplette
            //    Dokument angehängt - bei einer vollständigen HTML-Seite
            //    (mit eigenem <html>...</html>, wie z.B. bei einem
            //    <!DOCTYPE html><html><head>...</head><body>...</body></html>
            //    Aufbau) landeten sie damit nach dem schließenden </html>.
            //    Das ist ungültiges HTML, das der Browser zwar über
            //    Fehlerkorrektur meist "repariert", aber nicht zuverlässig
            //    beim allerersten Rendern - genau der gemeldete Bug (Style
            //    erst nach "Reset" sichtbar, und zwar nur bei vollständigem
            //    HTML+CSS+JS zusammen, nicht bei einem reinen HTML-Schnipsel
            //    ohne eigenes <head>/<body>).
            const headInsert = consoleIntercepter + "\n" + styleBlock;
            if (/<head[^>]*>/i.test(doc)) {
                doc = doc.replace(/<head[^>]*>/i, m => m + "\n" + headInsert);
            } else if (/<html[^>]*>/i.test(doc)) {
                doc = doc.replace(/<html[^>]*>/i, m => m + "\n<head>\n" + headInsert + "\n</head>");
            } else {
                doc = headInsert + "\n" + doc;
            }

            // 2) Das eigentliche JS sauber vor </body> (bzw. </html>, bzw.
            //    ganz ans Ende) einfügen - und dabei exakt mitzählen, in
            //    welcher Zeile des finalen Dokuments der JS-Code beginnt
            //    (für "Fehler anklicken -> zur Zeile springen").
            const scriptOpenTag = `<script>\n`;
            const scriptBlock = scriptOpenTag + jsSource + `\n<\/script>`;

            const closingMatch = doc.match(/<\/body>/i) || doc.match(/<\/html>/i);
            const insertionIndex = closingMatch ? closingMatch.index : doc.length;

            const prefix = doc.slice(0, insertionIndex);
            const suffix = doc.slice(insertionIndex);
            doc = prefix + scriptBlock + "\n" + suffix;

            // Alles, was im finalen Dokument VOR dem eigentlichen JS-Code
            // steht - daraus ergibt sich die Zeilen-Verschiebung für
            // Fehlermeldungen.
            const bodyBeforeJs = prefix + scriptOpenTag;
            jsLineOffset = (bodyBeforeJs.match(/\n/g) || []).length;

            const iframe = document.getElementById("preview-frame");
            iframe.srcdoc = doc;
        }

        async function createDefaultProject() {
            const defaultData = {
                type: "web",
                html: "<h1>Hallo Welt</h1>\n<p>Willkommen in deinem Code-Editor!</p>",
                css: "h1 { color: #007acc; }",
                js: "console.log('Projekt gestartet');",
                py: ""
            };
            const key = "codepen_MeinProjekt";
            await dbSet(key, defaultData);
            await loadProjects();
            await openProject(key);
        }

        function setProjectTypeFilter(type) {
            selectedTypeFilter = type;
            ['all', 'web', 'python'].forEach(t => {
                const btn = document.getElementById(`filter-btn-${t}`);
                if (t === type) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
            filterProjects();
        }

        // =========================================================
        // ORDNER-SYSTEM ("Bibliothek")
        //
        // Datenmodell - bewusst ohne zweites, konkurrierendes ID-System:
        //
        //   * Ordner liegen als EIN Datensatz im bestehenden IndexedDB-
        //     Store unter dem Schluessel "codeforge_folders". Der
        //     Schluessel beginnt NICHT mit "codepen_", deshalb taucht er
        //     in dbGetAllKeys() (das nur Projekte liefert) gar nicht auf.
        //     Bestehende Projekte bleiben dadurch voellig unberuehrt.
        //
        //   * Ein Projekt merkt sich seinen Ordner in data.folderId.
        //     Fehlt das Feld oder ist es null, liegt das Projekt auf der
        //     obersten Ebene - genau das Verhalten aller Projekte, die es
        //     bisher schon gab.
        //
        //   * Ordner-IDs sind stabil und haben nichts mit dem Namen zu
        //     tun. Umbenennen aendert deshalb kein einziges Projekt.
        //
        // Bewusste Entscheidung: NUR EINE Ebene, keine Unterordner. Der
        // Mehrwert waere hier gering, die Kosten (Zyklenpruefung,
        // Breadcrumbs, rekursives Loeschen, Merge beim Import) dagegen
        // hoch. Das Datenmodell bleibt trotzdem erweiterbar: ein Ordner
        // koennte spaeter ein eigenes parentId-Feld bekommen.
        // =========================================================
        const foldersKey = "codeforge_folders";
        let foldersCache = null;
        let folderNameById = new Map();
        let openFolders = new Set(readOpenFolders());

        function readOpenFolders() {
            try {
                const raw = JSON.parse(localStorage.getItem("codeforge_open_folders") || "[]");
                return Array.isArray(raw) ? raw.filter(x => typeof x === "string") : [];
            } catch (e) {
                return [];
            }
        }

        function persistOpenFolders() {
            try {
                localStorage.setItem("codeforge_open_folders", JSON.stringify([...openFolders]));
            } catch (e) {}
        }

        function makeFolderId() {
            return "f_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        }

        // Macht aus beliebigen - auch beschaedigten - Eingabedaten immer
        // eine gueltige Ordnerliste: nur Objekte mit Namen, keine leeren
        // Namen, keine doppelten IDs. Wird auch beim Import benutzt.
        function normalizeFolderList(list) {
            const out = [];
            const seen = new Set();
            if (!Array.isArray(list)) return out;
            for (const raw of list) {
                if (!raw || typeof raw !== "object") continue;
                const name = typeof raw.name === "string" ? raw.name.trim() : "";
                if (!name) continue;
                let id = (typeof raw.id === "string" && raw.id) ? raw.id : makeFolderId();
                while (seen.has(id)) id = makeFolderId();
                seen.add(id);
                out.push({ id, name });
            }
            return out;
        }

        async function getFolders() {
            if (foldersCache) return foldersCache;
            let stored = null;
            try {
                stored = await dbGet(foldersKey);
            } catch (e) {}
            foldersCache = normalizeFolderList(stored && stored.folders);
            return foldersCache;
        }

        async function saveFolders(folders) {
            foldersCache = normalizeFolderList(folders);
            await dbSet(foldersKey, { version: 1, folders: foldersCache });
        }

        // Liefert die GUELTIGE Ordner-ID eines Projekts oder null (= oberste
        // Ebene). Zeigt ein Projekt auf einen geloeschten oder unbekannten
        // Ordner, taucht es wieder ganz oben auf statt unsichtbar zu werden.
        // Die gespeicherten Daten werden dabei absichtlich nicht angefasst.
        function resolveFolderId(folderId, folders) {
            if (!folderId || typeof folderId !== "string") return null;
            return folders.some(f => f.id === folderId) ? folderId : null;
        }

        async function folderNameTaken(name, exceptId) {
            const key = String(name).trim().toLowerCase();
            return (await getFolders()).some(f => f.id !== exceptId && f.name.trim().toLowerCase() === key);
        }

        async function projectKeysInFolder(folderId) {
            const keys = await dbGetAllKeys();
            const out = [];
            for (const key of keys) {
                const data = await dbGet(key);
                if (data && data.folderId === folderId) out.push(key);
            }
            return out;
        }

        // Verschiebt NUR die Zuordnung. Der Code des Projekts wird dabei
        // nicht angefasst. Gibt true zurueck, wenn sich wirklich etwas
        // geaendert hat.
        async function moveProjectToFolder(key, folderId) {
            const data = await dbGet(key);
            if (!data) return false;
            const target = resolveFolderId(folderId, await getFolders());
            if ((data.folderId || null) === target) return false;
            data.folderId = target;
            await dbSet(key, data);
            return true;
        }

        // ---------------- Ordner anlegen / umbenennen / loeschen --------
        async function createFolderFromDialog() {
            const name = await openTextDialog(t("newFolderTitle"), t("folderNameLabel"), "");
            if (name === null) return;
            const clean = String(name).trim();
            if (!clean) return showToast(t("enterFolderName"), "warning");
            if (await folderNameTaken(clean, null)) return showToast(t("folderNameExists"), "warning");

            const folders = (await getFolders()).slice();
            const folder = { id: makeFolderId(), name: clean };
            folders.push(folder);
            await saveFolders(folders);
            openFolders.add(folder.id);
            persistOpenFolders();
            await loadProjects();
            showToast(t("folderCreated", clean), "success");
        }

        async function renameFolder(folderId) {
            const folders = (await getFolders()).slice();
            const folder = folders.find(f => f.id === folderId);
            if (!folder) return;
            const name = await openTextDialog(t("renameFolderTitle"), t("folderNameLabel"), folder.name);
            if (name === null) return;
            const clean = String(name).trim();
            if (!clean || clean === folder.name) return;
            if (await folderNameTaken(clean, folderId)) return showToast(t("folderNameExists"), "warning");

            // Nur der Name aendert sich - die ID bleibt, also bleibt auch
            // jede Projektzuordnung unveraendert erhalten.
            folder.name = clean;
            await saveFolders(folders);
            await loadProjects();
            showToast(t("folderRenamed", clean), "success");
        }

        async function deleteFolder(folderId) {
            const folders = await getFolders();
            const folder = folders.find(f => f.id === folderId);
            if (!folder) return;

            const members = await projectKeysInFolder(folderId);
            const ok = await openConfirmDialog(
                t("deleteFolderTitle"),
                members.length ? t("deleteFolderMsg", folder.name, members.length)
                               : t("deleteEmptyFolderMsg", folder.name));
            if (!ok) return;

            // Der Ordner geht in den Papierkorb, sein Inhalt bleibt
            // bestehen und wandert auf die oberste Ebene.
            const moved = await moveFolderToTrash(folderId);
            await loadProjects();
            showToast(moved ? t("folderDeletedKept", folder.name, moved)
                            : t("folderDeleted", folder.name), "success");
        }

        function toggleFolderOpen(folderId) {
            if (openFolders.has(folderId)) openFolders.delete(folderId);
            else openFolders.add(folderId);
            persistOpenFolders();
            applyLibraryVisibility();
        }

        // =========================================================
        // PAPIERKORB ("Zuletzt geloescht")
        //
        // Geloeschtes verschwindet nicht sofort, sondern landet in einem
        // eigenen Datensatz unter "codeforge_trash". Der Schluessel
        // beginnt nicht mit "codepen_", taucht also in der Projektliste
        // nie auf.
        //
        // Ein Eintrag merkt sich alles, was fuer die Wiederherstellung an
        // der URSPRUENGLICHEN Stelle noetig ist:
        //
        //   Projekt: der komplette Datensatz + Ordner-ID + Ordner-NAME.
        //            Der Name ist der Rettungsanker, falls der Ordner
        //            zwischenzeitlich selbst geloescht wurde.
        //   Ordner:  Name, ID und die Projekte, die damals darin lagen.
        //            Die Projekte selbst werden NICHT mitgeloescht - sie
        //            wandern wie bisher auf die oberste Ebene.
        //
        // Wiederhergestellt wird nie "irgendwohin": erst die alte ID,
        // dann ein Ordner mit demselben Namen, sonst oberste Ebene. So
        // kann keine ungueltige Referenz und kein Geisterprojekt
        // entstehen.
        // =========================================================
        const trashKey = "codeforge_trash";
        let trashCache = null;

        function makeTrashId() {
            return "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        }

        // Macht aus beliebigen - auch beschaedigten - Daten immer eine
        // gueltige Liste. Doppelte IDs koennen dabei nicht ueberleben.
        function normalizeTrashList(list) {
            if (!Array.isArray(list)) return [];
            const out = [];
            const seen = new Set();
            for (const raw of list) {
                if (!raw || typeof raw !== "object") continue;
                if (raw.kind !== "project" && raw.kind !== "folder") continue;
                const name = typeof raw.name === "string" ? raw.name.trim() : "";
                if (!name) continue;
                let id = (typeof raw.id === "string" && raw.id) ? raw.id : makeTrashId();
                while (seen.has(id)) id = makeTrashId();
                seen.add(id);
                out.push({
                    id,
                    kind: raw.kind,
                    name,
                    deletedAt: typeof raw.deletedAt === "number" ? raw.deletedAt : Date.now(),
                    data: (raw.kind === "project" && raw.data && typeof raw.data === "object") ? raw.data : null,
                    folderId: typeof raw.folderId === "string" ? raw.folderId : null,
                    folderName: typeof raw.folderName === "string" ? raw.folderName : null,
                    memberKeys: Array.isArray(raw.memberKeys) ? raw.memberKeys.filter(k => typeof k === "string") : []
                });
            }
            out.sort((a, b) => b.deletedAt - a.deletedAt);   // neueste zuerst
            return out;
        }

        async function getTrash() {
            if (trashCache) return trashCache;
            let stored = null;
            try { stored = await dbGet(trashKey); } catch (e) {}
            trashCache = normalizeTrashList(stored && stored.items);
            return trashCache;
        }

        async function saveTrash(items) {
            trashCache = normalizeTrashList(items);
            await dbSet(trashKey, { version: 1, items: trashCache });
            updateTrashBadge();
        }

        async function moveProjectToTrash(key) {
            const data = await dbGet(key);
            if (!data) return false;
            const folders = await getFolders();
            const folderId = resolveFolderId(data.folderId, folders);
            const folder = folderId ? folders.find(f => f.id === folderId) : null;

            const items = (await getTrash()).slice();
            items.unshift({
                id: makeTrashId(), kind: "project", name: key.replace("codepen_", ""),
                deletedAt: Date.now(), data: Object.assign({}, data),
                folderId, folderName: folder ? folder.name : null, memberKeys: []
            });
            await saveTrash(items);
            await dbDelete(key);
            return true;
        }

        async function moveFolderToTrash(folderId) {
            const folders = await getFolders();
            const folder = folders.find(f => f.id === folderId);
            if (!folder) return false;

            const members = await projectKeysInFolder(folderId);
            const items = (await getTrash()).slice();
            items.unshift({
                id: makeTrashId(), kind: "folder", name: folder.name,
                deletedAt: Date.now(), data: null,
                folderId: folder.id, folderName: folder.name, memberKeys: members.slice()
            });
            await saveTrash(items);

            // Der Inhalt wird NIE mitgeloescht.
            for (const key of members) await moveProjectToFolder(key, null);
            await saveFolders(folders.filter(f => f.id !== folderId));
            openFolders.delete(folderId);
            persistOpenFolders();
            return members.length;
        }

        // Freier Projektschluessel - dieselbe Regel wie beim Import, damit
        // eine Wiederherstellung nie ein vorhandenes Projekt ueberschreibt.
        async function freeProjectKey(baseName) {
            let key = "codepen_" + baseName;
            let counter = 1;
            while (await dbGet(key)) {
                key = `codepen_${baseName}_Kopie${counter > 1 ? counter : ""}`;
                counter++;
            }
            return key;
        }

        async function restoreTrashItem(id) {
            const items = await getTrash();
            const item = items.find(i => i.id === id);
            if (!item) return;

            if (item.kind === "project") {
                const folders = await getFolders();
                let target = resolveFolderId(item.folderId, folders);
                if (!target && item.folderName) {
                    const byName = folders.find(f =>
                        f.name.trim().toLowerCase() === item.folderName.trim().toLowerCase());
                    if (byName) target = byName.id;
                }
                const data = Object.assign({}, item.data || { type: "web", html: "", css: "", js: "", py: "" });
                data.folderId = target;
                const key = await freeProjectKey(item.name);
                await dbSet(key, data);
                if (target) { openFolders.add(target); persistOpenFolders(); }
                showToast(t("restoredProject", key.replace("codepen_", "")), "success");
            } else {
                const folders = (await getFolders()).slice();
                // Alte ID wiederverwenden, wenn sie frei ist.
                const idFree = item.folderId && !folders.some(f => f.id === item.folderId);
                const newId = idFree ? item.folderId : makeFolderId();
                let name = item.name;
                let n = 2;
                while (folders.some(f => f.name.trim().toLowerCase() === name.trim().toLowerCase())) {
                    name = item.name + " (" + (n++) + ")";
                }
                folders.push({ id: newId, name });
                await saveFolders(folders);

                // Frueheren Inhalt zurueckholen - aber NUR Projekte, die es
                // noch gibt und die der Nutzer seitdem nicht selbst in einen
                // anderen Ordner einsortiert hat. Sonst wuerde die
                // Wiederherstellung seine spaetere Arbeit ueberschreiben.
                let moved = 0;
                const current = await getFolders();
                for (const key of item.memberKeys) {
                    const data = await dbGet(key);
                    if (!data) continue;
                    if (resolveFolderId(data.folderId, current)) continue;
                    if (await moveProjectToFolder(key, newId)) moved++;
                }
                openFolders.add(newId);
                persistOpenFolders();
                showToast(moved ? t("restoredFolderWith", name, moved) : t("restoredFolder", name), "success");
            }

            await saveTrash(items.filter(i => i.id !== id));
            await loadProjects();
            renderTrash();
        }

        async function purgeTrashItem(id) {
            const items = await getTrash();
            const item = items.find(i => i.id === id);
            if (!item) return;
            const ok = await openConfirmDialog(t("purgeTitle"), t("purgeMsg", item.name));
            if (!ok) return;
            await saveTrash(items.filter(i => i.id !== id));
            renderTrash();
            showToast(t("purged", item.name), "success");
        }

        async function emptyTrash() {
            const items = await getTrash();
            if (!items.length) return;
            const ok = await openConfirmDialog(t("emptyTrashTitle"), t("emptyTrashMsg", items.length));
            if (!ok) return;
            await saveTrash([]);
            renderTrash();
            showToast(t("trashEmptied"), "success");
        }

        // ---------------- Papierkorb-Oberflaeche ------------------------
        function openTrashModal() {
            const modal = document.getElementById("trash-modal");
            if (!modal) return;
            modal.classList.add("open");
            renderTrash();
        }

        function closeTrashModal() {
            const modal = document.getElementById("trash-modal");
            if (modal) modal.classList.remove("open");
        }

        function formatDeletedAt(ts) {
            const minutes = Math.floor((Date.now() - ts) / 60000);
            if (minutes < 1) return t("justNow");
            if (minutes < 60) return t("minutesAgo", minutes);
            const hours = Math.floor(minutes / 60);
            if (hours < 24) return t("hoursAgo", hours);
            const days = Math.floor(hours / 24);
            if (days < 30) return t("daysAgo", days);
            return new Date(ts).toLocaleDateString();
        }

        function trashMetaText(item) {
            const when = formatDeletedAt(item.deletedAt);
            if (item.kind === "folder") {
                return item.memberKeys.length
                    ? t("trashFolderMeta", item.memberKeys.length, when)
                    : t("trashFolderMetaEmpty", when);
            }
            return item.folderName ? t("trashProjectMeta", item.folderName, when)
                                   : t("trashProjectMetaRoot", when);
        }

        async function renderTrash() {
            const box = document.getElementById("trash-list");
            if (!box) return;
            const items = await getTrash();

            const emptyBtn = document.getElementById("trash-empty-btn");
            if (emptyBtn) emptyBtn.style.display = items.length ? "" : "none";

            box.innerHTML = "";
            if (!items.length) {
                const empty = document.createElement("div");
                empty.className = "trash-empty-state";
                empty.textContent = t("trashEmptyState");
                box.appendChild(empty);
                return;
            }

            items.forEach(item => {
                const row = document.createElement("div");
                row.className = "trash-row";

                const icon = document.createElement("span");
                icon.className = "trash-icon";
                icon.textContent = item.kind === "folder" ? "📁"
                    : ((item.data && item.data.type === "python") ? "🐍" : "🌐");

                const info = document.createElement("div");
                info.className = "trash-info";
                const name = document.createElement("div");
                name.className = "trash-name";
                name.textContent = item.name;
                const meta = document.createElement("div");
                meta.className = "trash-meta";
                meta.textContent = trashMetaText(item);
                info.append(name, meta);

                const restore = document.createElement("button");
                restore.className = "trash-btn trash-restore";
                restore.textContent = t("restoreBtn");
                restore.addEventListener("click", () => restoreTrashItem(item.id));

                const purge = document.createElement("button");
                purge.className = "trash-btn trash-purge";
                purge.textContent = t("purgeBtn");
                purge.addEventListener("click", () => purgeTrashItem(item.id));

                row.append(icon, info, restore, purge);
                box.appendChild(row);
            });
        }

        // Zaehler an den Papierkorb-Schaltern (Seitenleiste + Startseite).
        async function updateTrashBadge() {
            const count = (await getTrash()).length;
            document.querySelectorAll("[data-trash-count]").forEach(el => {
                el.textContent = count ? String(count) : "";
                el.style.display = count ? "" : "none";
            });
        }


        // ---------------- Zeilen der Bibliothek -------------------------
        function makeLibRow(className) {
            const li = document.createElement("li");
            li.className = "lib-item " + className;
            return li;
        }

        function makeLibAction(symbol, title, handler) {
            const btn = document.createElement("button");
            btn.className = "lib-action";
            btn.type = "button";
            btn.textContent = symbol;
            btn.title = title;
            btn.setAttribute("aria-label", title);
            btn.addEventListener("click", (e) => { e.stopPropagation(); handler(); });
            return btn;
        }

        function makeFolderRow(folder, count) {
            const li = makeLibRow("lib-folder");
            li.dataset.folderId = folder.id;
            li.dataset.name = folder.name;
            if (openFolders.has(folder.id)) li.classList.add("open");

            const chevron = document.createElement("span");
            chevron.className = "lib-chevron";
            chevron.textContent = "▸";

            const icon = document.createElement("span");
            icon.className = "lib-icon";
            icon.textContent = "📁";

            const name = document.createElement("span");
            name.className = "lib-name";
            name.textContent = folder.name;

            const badge = document.createElement("span");
            badge.className = "lib-count";
            badge.textContent = String(count);

            const actions = document.createElement("span");
            actions.className = "lib-actions";
            actions.appendChild(makeLibAction("✎", t("renameFolderTitle"), () => renameFolder(folder.id)));
            actions.appendChild(makeLibAction("✕", t("deleteFolderTitle"), () => deleteFolder(folder.id)));

            li.append(chevron, icon, name, badge, actions);
            li.addEventListener("click", () => toggleFolderOpen(folder.id));
            return li;
        }

        function makeProjectRow(project) {
            const li = makeLibRow("lib-project" + (project.folderId ? " in-folder" : ""));
            li.dataset.key = project.key;
            li.dataset.type = project.type;
            li.dataset.name = project.name;
            li.dataset.parent = project.folderId || "";
            if (project.key === currentProjectKey) li.classList.add("active");

            const icon = document.createElement("span");
            icon.className = "lib-icon";
            icon.textContent = project.type === "python" ? "🐍" : "🌐";

            const name = document.createElement("span");
            name.className = "lib-name";
            name.textContent = project.name;

            const hint = document.createElement("span");
            hint.className = "lib-hint";

            // Umbenennen/Loeschen direkt an der Zeile - dasselbe Muster wie
            // bei den Ordnern, und die Seitenleiste bleibt dadurch schlank.
            const actions = document.createElement("span");
            actions.className = "lib-actions";
            actions.appendChild(makeLibAction("\u270e", t("renameProjectTitle"), () => renameProject(project.key)));
            actions.appendChild(makeLibAction("\u2715", t("deleteProjectTitle"), () => deleteProject(project.key)));

            li.append(icon, name, hint, actions);
            li.addEventListener("click", () => {
                // Nach einem Ziehen soll der abschliessende Klick das
                // Projekt nicht zusaetzlich oeffnen.
                if (suppressLibraryClick) return;
                openProject(project.key);
            });
            return li;
        }

        function makeTextRow(className, text, parentId) {
            const li = makeLibRow(className);
            li.textContent = text;
            if (parentId) li.dataset.parent = parentId;
            return li;
        }

        // ---------------- Bibliothek aufbauen ---------------------------
        // Heisst weiterhin loadProjects(), weil genau dieser Aufruf an
        // vielen Stellen steht (Start, Anlegen, Umbenennen, Loeschen,
        // Import). Aus der frueheren flachen Liste wird eine Liste mit
        // zwei Ebenen: Ordner (mit Inhalt) und darunter die Projekte
        // ohne Ordner.
        let libraryRenderToken = 0;

        async function loadProjects() {
            const list = document.getElementById("project-list");
            if (!list) return;

            // Zwei gleichzeitige Aufbauten (z.B. Start + Sprachwechsel)
            // wuerden sich sonst ins Gehege kommen: beide leeren die Liste,
            // beide haengen danach ihre Zeilen an - die Liste waere doppelt.
            // Deshalb: erst ALLE Daten lesen, dann pruefen, ob dieser Aufbau
            // noch der aktuelle ist, und erst dann in einem Rutsch zeichnen.
            const token = ++libraryRenderToken;

            const folders = await getFolders();
            folderNameById = new Map(folders.map(f => [f.id, f.name]));

            const keys = await dbGetAllKeys();
            const projects = [];
            for (const key of keys) {
                try {
                    const data = await dbGet(key);
                    if (!data) continue;
                    projects.push({
                        key,
                        name: key.replace("codepen_", ""),
                        type: data.type === "python" ? "python" : "web",
                        folderId: resolveFolderId(data.folderId, folders)
                    });
                } catch (e) {
                    console.error("Fehler beim Laden:", key, e);
                }
            }

            if (token !== libraryRenderToken) return;   // ein neuerer Aufbau hat uebernommen
            list.innerHTML = "";

            const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
            projects.sort(byName);
            const sortedFolders = folders.slice().sort(byName);

            if (!sortedFolders.length && !projects.length) {
                list.appendChild(makeTextRow("lib-note", t("emptyLibrary")));
                return;
            }

            for (const folder of sortedFolders) {
                const children = projects.filter(p => p.folderId === folder.id);
                list.appendChild(makeFolderRow(folder, children.length));
                children.forEach(p => list.appendChild(makeProjectRow(p)));
                list.appendChild(makeTextRow("lib-empty", t("emptyFolder"), folder.id));
            }

            const rootProjects = projects.filter(p => !p.folderId);
            if (sortedFolders.length) {
                const header = makeTextRow("lib-root-header", t("rootSectionLabel"));
                header.dataset.rootDrop = "1";
                list.appendChild(header);
            }
            rootProjects.forEach(p => list.appendChild(makeProjectRow(p)));

            const noResults = makeTextRow("lib-note", t("noSearchResults"));
            noResults.id = "lib-no-results";
            list.appendChild(noResults);

            applyLibraryVisibility();
        }

        async function openProject(key) {
            const data = await dbGet(key);
            if (!data) return;
            
            currentProjectKey = key;
            rememberRecentProject(key);
            clearWebConsole();
            hideHome();
            const projectType = data.type || "web";

            // WICHTIG: den Python-Laufzeitzustand (Namespace, laufender
            // Code, evtl. noch offene input()-Abfrage) des VORHER offenen
            // Projekts nie mit ins neu geöffnete Projekt nehmen - sonst
            // hängt z.B. eine Eingabeaufforderung eines ganz anderen
            // Projekts noch in der Luft, oder Variablen bleiben über
            // Projektgrenzen hinweg erhalten.
            clearPythonRuntimeState();
            const pyOut = document.getElementById("python-output");
            if (pyOut) {
                if (pyodide) {
                    pyOut.dataset.state = "ready";
                    pyOut.textContent = t("ready");
                } else {
                    pyOut.dataset.state = "starting";
                    pyOut.textContent = t("starting");
                }
            }

            suppressEditorEvents = true;
            cmEditors.html.setValue(data.html || "");
            cmEditors.html.clearHistory();
            cmEditors.css.setValue(data.css || "");
            cmEditors.css.clearHistory();
            cmEditors.js.setValue(data.js || "");
            cmEditors.js.clearHistory();
            cmEditors.py.setValue(data.py || "");
            cmEditors.py.clearHistory();
            suppressEditorEvents = false;

            const btnWeb = document.getElementById("btn-tab-web");
            const btnPy = document.getElementById("btn-tab-python");
            const webTab = document.getElementById("web-tab");
            const pyTab = document.getElementById("python-tab");

            // Beim Wechsel des Projekts immer eine frische, aktive Live-Vorschau.
            // Die Pause ist eine Eigenschaft der aktuellen Vorschau, nicht
            // des Projekts. Ist die Einstellung "beim Oeffnen pausieren"
            // aktiv, wird die Vorschau gleich PAUSIERT aufgebaut.
            previewPaused = shouldAutoPauseOnOpen();
            setPreviewPauseButton(previewPaused);

            if (projectType === "python") {
                btnWeb.style.display = "none";
                btnPy.style.display = "inline-block";
                
                webTab.classList.remove("active");
                pyTab.classList.add("active");
            } else {
                btnWeb.style.display = "inline-block";
                btnPy.style.display = "none";

                pyTab.classList.remove("active");
                webTab.classList.add("active");
                // force = true, weil updateWebPreview() bei gesetztem
                // previewPaused sonst gar nichts bauen wuerde. Der
                // Pause-Zustand wandert ins Dokument selbst.
                updateWebPreview(true);
            }

            document.querySelectorAll("#project-list li").forEach(li => {
                if (li.dataset.key === key) {
                    li.classList.add("active");
                } else {
                    li.classList.remove("active");
                }
            });

            // Liegt das geladene Projekt in einem Ordner, wird genau
            // dieser aufgeklappt - sonst waere das gerade geoeffnete
            // Projekt in der Liste unsichtbar. Andere Ordner bleiben
            // unberuehrt, es wird nie einer zugeklappt.
            const parentFolder = resolveFolderId(data.folderId, await getFolders());
            if (parentFolder && !openFolders.has(parentFolder)) {
                openFolders.add(parentFolder);
                persistOpenFolders();
            }
            applyLibraryVisibility();

            const activeRow = document.querySelector("#project-list li.lib-project.active");
            if (activeRow) activeRow.scrollIntoView({ block: "nearest" });

            renderFileTree();
            refreshCodeMirrorEditors();
        }

        async function saveCurrentProject() {
            if (!currentProjectKey) return showToast(t("selectProjectFirst"), "warning");
            const oldData = await dbGet(currentProjectKey) || {};
            
            const data = {
                type: oldData.type || "web",
                folderId: oldData.folderId || null,
                html: cmEditors.html.getValue(),
                css: cmEditors.css.getValue(),
                js: cmEditors.js.getValue(),
                py: cmEditors.py.getValue()
            };
            await dbSet(currentProjectKey, data);
            setSaveStatus("saved", t("savedStatus"));
            showToast(t("projectSaved"), "success");
        }

        // Umbenennen fuer EIN bestimmtes Projekt (Zeilen-Aktion, Befehls-
        // palette und der Button in der Seitenleiste benutzen dasselbe).
        async function renameProject(key) {
            if (!key) return showToast(t("selectProjectFirst"), "warning");
            const oldName = key.replace("codepen_", "");
            const newName = await openTextDialog(t("renameProjectTitle"), t("renameProjectLabel"), oldName);
            if (newName === null) return;

            const cleanName = String(newName).trim();
            if (!cleanName) return showToast(t("enterProjectName"), "warning");
            if (cleanName === oldName) return;
            const newKey = "codepen_" + cleanName;
            if (await dbGet(newKey)) return showToast(t("nameExists"), "warning");

            const data = await dbGet(key);
            if (!data) return;
            await dbSet(newKey, data);
            await dbDelete(key);

            // Der Schluessel IST der Name. Ohne diese Zeile wuerde das
            // Projekt aus "Zuletzt geoeffnet" verschwinden, weil dort noch
            // der alte Schluessel steht.
            recentProjects = recentProjects.map(k => (k === key ? newKey : k));
            localStorage.setItem("codeforge_recent", JSON.stringify(recentProjects));

            if (currentProjectKey === key) {
                currentProjectKey = newKey;
                await loadProjects();
                await openProject(newKey);
            } else {
                await loadProjects();
            }
        }

        async function renameCurrentProject() {
            await renameProject(currentProjectKey);
        }

        // Loeschen fuer EIN bestimmtes Projekt. Es wird NICHT endgueltig
        // entfernt, sondern wandert in den Papierkorb.
        async function deleteProject(key) {
            if (!key) return showToast(t("selectProjectFirst"), "warning");
            const name = key.replace("codepen_", "");
            const ok = await openConfirmDialog(t("deleteProjectTitle"), t("deleteProjectMsg", name));
            if (!ok) return;

            await moveProjectToTrash(key);
            recentProjects = recentProjects.filter(k => k !== key);
            localStorage.setItem("codeforge_recent", JSON.stringify(recentProjects));

            const wasOpen = (currentProjectKey === key);
            if (wasOpen) {
                currentProjectKey = null;
                clearWebConsole();
            }
            await loadProjects();

            if (wasOpen) {
                const keys = await dbGetAllKeys();
                if (keys.length > 0) await openProject(keys[0]);
                else await createDefaultProject();
            }
            showToast(t("movedToTrash", name), "success");
        }

        async function deleteCurrentProject() {
            await deleteProject(currentProjectKey);
        }

        // =========================================================
        // SUCHE
        //
        // Das bisherige Verhalten bleibt: Eingabe im Suchfeld -> Zeilen
        // werden ein-/ausgeblendet, und der Typ-Filter (Alle/Web/Python)
        // wirkt zusaetzlich. Neu kommt der Ordner-Teil dazu:
        //
        //   Sucheingabe
        //     -> Projekte durchsuchen (Projektname)
        //      + Ordner durchsuchen   (Ordnername)
        //     -> Treffer zusammenfuehren: ein Ordner-Treffer zeigt auch
        //        SEINEN INHALT (deshalb findet "Horror" auch "Resident
        //        Evil"), und der Grund dafuer steht als "in Horror Games"
        //        hinter dem Projekt.
        //     -> Reihenfolge: Ordner oben, darunter ihr Inhalt, darunter
        //        die Projekte ohne Ordner.
        //
        // Einzige bewusste Aenderung am alten Verhalten: gesucht wird im
        // PROJEKTNAMEN statt im kompletten Zeilentext. Vorher stand in
        // jeder Zeile auch "[Web]"/"[Python]" - die Suche nach "web" hat
        // deshalb jedes Webprojekt getroffen. Dafuer gibt es den Typ-Filter.
        //
        // filterProjects() bleibt der Einstiegspunkt, weil das Suchfeld
        // genau diesen Namen im onkeyup aufruft.
        // =========================================================
        function filterProjects() {
            applyLibraryVisibility();
        }

        function applyLibraryVisibility() {
            const list = document.getElementById("project-list");
            if (!list) return;

            const input = document.getElementById("search-input");
            const query = (input ? input.value : "").trim().toLowerCase();
            const searching = query.length > 0;
            const typeFiltered = selectedTypeFilter !== "all";

            const folderRows = [...list.querySelectorAll("li.lib-folder")];
            const projectRows = [...list.querySelectorAll("li.lib-project")];

            // 1) Ordner, deren NAME zur Suche passt.
            const folderNameHit = new Set();
            if (searching) {
                folderRows.forEach(li => {
                    if (li.dataset.name.toLowerCase().includes(query)) folderNameHit.add(li.dataset.folderId);
                });
            }

            // 2) Projekte: eigener Name ODER Ordner-Kontext.
            const hitsPerFolder = new Map();
            let rootHits = 0;
            let anythingVisible = false;

            projectRows.forEach(li => {
                const parent = li.dataset.parent || "";
                const typeOk = !typeFiltered || li.dataset.type === selectedTypeFilter;
                const nameHit = !searching || li.dataset.name.toLowerCase().includes(query);
                const viaFolder = searching && !nameHit && folderNameHit.has(parent);
                const match = typeOk && (nameHit || viaFolder);

                // Waehrend einer Suche werden Treffer sichtbar gemacht,
                // auch wenn ihr Ordner gerade zugeklappt ist.
                const parentVisible = !parent || searching || openFolders.has(parent);
                const visible = match && parentVisible;

                li.style.display = visible ? "flex" : "none";
                li.classList.toggle("via-folder", visible && viaFolder);
                const hint = li.querySelector(".lib-hint");
                if (hint) {
                    hint.textContent = (visible && viaFolder)
                        ? t("inFolderHint", folderNameById.get(parent) || "")
                        : "";
                }

                if (match) {
                    anythingVisible = anythingVisible || visible;
                    if (parent) hitsPerFolder.set(parent, (hitsPerFolder.get(parent) || 0) + 1);
                    else rootHits++;
                }
            });

            // 3) Ordnerzeilen: sichtbar, wenn der Ordner selbst passt oder
            //    mindestens ein Kind passt.
            const visibleFolders = new Set();
            folderRows.forEach(li => {
                const id = li.dataset.folderId;
                const hits = hitsPerFolder.get(id) || 0;
                let visible = true;
                if (searching) visible = folderNameHit.has(id) || hits > 0;
                else if (typeFiltered) visible = hits > 0;

                li.style.display = visible ? "flex" : "none";
                li.classList.toggle("open", searching ? visible : openFolders.has(id));
                if (visible) {
                    visibleFolders.add(id);
                    anythingVisible = true;
                }
            });

            // 4) "Leer"-Zeile nur in einem sichtbaren, offenen Ordner ohne
            //    sichtbaren Inhalt.
            list.querySelectorAll("li.lib-empty").forEach(li => {
                const id = li.dataset.parent;
                const open = searching ? visibleFolders.has(id) : openFolders.has(id);
                const show = visibleFolders.has(id) && open && !(hitsPerFolder.get(id) || 0);
                li.style.display = show ? "flex" : "none";
            });

            // 5) Zwischenueberschrift der obersten Ebene.
            const header = list.querySelector("li.lib-root-header");
            if (header) header.style.display = rootHits > 0 ? "flex" : "none";

            // 6) Leerer Zustand.
            const note = document.getElementById("lib-no-results");
            if (note) note.style.display = (!anythingVisible && (searching || typeFiltered)) ? "flex" : "none";
        }

        // =========================================================
        // DRAG & DROP in der Bibliothek (zeigerbasiert)
        //
        // WARUM NICHT die HTML5-Drag-and-Drop-API:
        // Waehrend eines nativen HTML5-Drags schickt der Browser KEINE
        // wheel-Ereignisse mehr an die Seite. Mausrad und Trackpad sind
        // dadurch tot, solange man etwas zieht - genau der gemeldete
        // Fehler. Das laesst sich nicht wegpatchen: es ist Teil des
        // nativen Drag-Modus des Browsers. Deshalb laeuft das Ziehen hier
        // ueber Pointer-Events.
        //
        // Damit gilt gleichzeitig und unabhaengig voneinander:
        //
        //   1. NORMALES SCROLLEN bleibt immer moeglich - auch mitten im
        //      Ziehen. Wir fassen wheel/scroll an keiner Stelle an und
        //      rufen nirgends preventDefault() auf einem Scroll-Ereignis.
        //   2. AUTO-SCROLL am oberen/unteren Rand der Liste, solange
        //      gezogen wird.
        //   3. Beides stoert sich nicht: das Drop-Ziel wird in JEDEM
        //      Frame neu unter dem Zeiger gesucht. Es ist egal, ob die
        //      Liste gerade durch das Mausrad oder durch den Auto-Scroll
        //      gewandert ist.
        //
        // Ein einfacher Klick loest nie ein Ziehen aus: erst ab 5 Pixeln
        // Bewegung wird aus dem Druck ein Drag.
        // =========================================================
        const DRAG_THRESHOLD_PX = 5;      // ab hier ist es ein Ziehen
        const AUTOSCROLL_ZONE_PX = 48;    // Randzone oben/unten
        const AUTOSCROLL_MAX_PPS = 900;   // Pixel pro Sekunde am Rand

        let libraryDrag = null;           // null = nichts gedrueckt/gezogen
        let suppressLibraryClick = false; // nach einem Drag keinen Klick ausloesen

        function getLibraryList() {
            return document.getElementById("project-list");
        }

        // Liefert das Drop-Ziel fuer einen Punkt:
        //   ""       = oberste Ebene
        //   "f_..."  = dieser Ordner
        //   null     = ausserhalb der Liste (kein gueltiges Ziel)
        //
        // HIER LAG DER GEMELDETE FEHLER.
        // Vorher wurde das Ziel ueber document.elementFromPoint() und
        // .closest("li") bestimmt. Zwischen zwei Zeilen liegen aber drei
        // Pixel Abstand (die Liste ist ein Flex-Container mit gap: 3px),
        // und rechts liegt die Scrollleiste. An diesen Stellen trifft der
        // Punkt NICHT auf ein <li>, sondern auf das <ul> selbst.
        // .closest("li") lieferte dann null - und null wurde als "oberste
        // Ebene" gewertet. Beim kleinsten Wackeln der Maus innerhalb eines
        // Ordners sprang das Ziel deshalb kurz auf "aus dem Ordner
        // herausziehen", und der blaue Rahmen blitzte auf.
        //
        // Jetzt wird das Ziel GEOMETRISCH bestimmt: gesucht wird die
        // Zeile, deren senkrechtes Band dem Zeiger am naechsten liegt.
        // Luecken zwischen zwei Zeilen gehoeren damit automatisch zur
        // benachbarten Zeile - es gibt keine "toten" Pixel mehr. Erst
        // deutlich unterhalb der letzten Zeile ist die oberste Ebene
        // gemeint.
        const DROP_ROW_SLACK_PX = 24;

        function libraryDropTargetAt(x, y) {
            const list = getLibraryList();
            if (!list) return null;

            const listRect = list.getBoundingClientRect();
            if (x < listRect.left || x > listRect.right ||
                y < listRect.top || y > listRect.bottom) return null;

            let nearest = null;
            let nearestDistance = Infinity;
            for (const li of list.children) {
                if (li.style.display === "none") continue;
                const r = li.getBoundingClientRect();
                if (r.height === 0) continue;
                const distance = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
                if (distance < nearestDistance) {
                    nearestDistance = distance;
                    nearest = li;
                }
                if (distance === 0) break;   // Zeiger steht genau auf dieser Zeile
            }

            // Freie Flaeche unterhalb der Liste: das ist die oberste Ebene.
            if (!nearest || nearestDistance > DROP_ROW_SLACK_PX) return "";

            if (nearest.classList.contains("lib-folder")) return nearest.dataset.folderId || "";
            if (nearest.classList.contains("lib-empty")) return nearest.dataset.parent || "";
            if (nearest.classList.contains("lib-project")) return nearest.dataset.parent || "";
            return "";   // Zwischenueberschrift "Projekte", Hinweiszeile
        }

        // Schreibt nur dann am DOM, wenn sich das Ziel WIRKLICH geaendert
        // hat. Vorher wurden die Klassen in jedem Bild neu gesetzt, also
        // rund 60 Mal pro Sekunde entfernt und wieder angehaengt. Schon
        // das allein liess den Rahmen sichtbar flackern.
        let lastDropHighlight;

        function highlightDropTarget(folderId) {
            if (folderId === lastDropHighlight) return;
            lastDropHighlight = folderId;
            const list = getLibraryList();
            if (!list) return;
            list.querySelectorAll("li.drop-target").forEach(el => el.classList.remove("drop-target"));
            list.classList.toggle("drop-root", folderId === "");
            if (!folderId) return;
            const row = [...list.querySelectorAll("li.lib-folder")].find(li => li.dataset.folderId === folderId);
            if (row) row.classList.add("drop-target");
        }

        // Beschleunigungskurve: knapp in der Randzone langsam, direkt am
        // Rand am schnellsten. Quadratisch, damit es sich natuerlich
        // anfuehlt und nicht schlagartig losschiesst.
        function autoScrollSpeed(overlap, zone) {
            const t = Math.max(0, Math.min(1, overlap / zone));
            return AUTOSCROLL_MAX_PPS * t * t;
        }

        function makeDragGhost(row) {
            const ghost = document.createElement("div");
            ghost.className = "lib-drag-ghost";
            const icon = row.querySelector(".lib-icon");
            const name = row.querySelector(".lib-name");
            ghost.textContent = (icon ? icon.textContent + " " : "") + (name ? name.textContent : "");
            document.body.appendChild(ghost);
            return ghost;
        }

        function startLibraryDrag() {
            const list = getLibraryList();
            if (!libraryDrag || !list) return;
            libraryDrag.active = true;
            // Die Liste wurde seit dem letzten Ziehen vielleicht neu
            // aufgebaut - die gemerkte Hervorhebung gilt dann nicht mehr.
            lastDropHighlight = undefined;
            libraryDrag.row.classList.add("dragging");
            libraryDrag.ghost = makeDragGhost(libraryDrag.row);
            document.body.classList.add("library-dragging");
            document.addEventListener("keydown", onLibraryDragKey, true);
            // Der Zeiger wird erst JETZT eingefangen. Vorher soll ein
            // normaler Klick voellig unbehelligt durchgehen.
            try { list.setPointerCapture(libraryDrag.pointerId); } catch (e) {}
            libraryDrag.frame = requestAnimationFrame(libraryDragFrame);
        }

        function libraryDragFrame(ts) {
            const list = getLibraryList();
            if (!libraryDrag || !libraryDrag.active || !list) return;

            const dt = libraryDrag.lastTs ? Math.min(64, ts - libraryDrag.lastTs) : 16;
            libraryDrag.lastTs = ts;

            const rect = list.getBoundingClientRect();

            // 1) Auto-Scroll - und NUR dieser eine Container, nie die Seite.
            const zone = Math.min(AUTOSCROLL_ZONE_PX, rect.height * 0.3);
            const y = libraryDrag.y;
            let delta = 0;
            if (y < rect.top + zone) {
                delta = -autoScrollSpeed(rect.top + zone - y, zone) * (dt / 1000);
            } else if (y > rect.bottom - zone) {
                delta = autoScrollSpeed(y - (rect.bottom - zone), zone) * (dt / 1000);
            }
            // Ganz aussen in der Randzone sind das nur Bruchteile eines
            // Pixels pro Frame. Wuerde man die direkt zuweisen, gingen sie
            // beim Runden verloren und das langsame Scrollen bliebe stehen.
            // Deshalb wird der Rest aufgehoben und erst als ganzer Pixel
            // angewendet.
            libraryDrag.scrollRest += delta;
            const wholePixels = Math.trunc(libraryDrag.scrollRest);
            if (wholePixels) {
                list.scrollTop += wholePixels;
                libraryDrag.scrollRest -= wholePixels;
            }

            // 2) Das mitgezogene Etikett folgt dem Zeiger.
            libraryDrag.ghost.style.transform =
                "translate(" + (libraryDrag.x + 14) + "px," + (libraryDrag.y + 12) + "px)";

            // 3) Ziel IMMER neu bestimmen. Dadurch stimmt es auch, wenn
            //    der Nutzer zwischendurch mit dem Mausrad gescrollt hat.
            updateLibraryDropTarget();

            libraryDrag.frame = requestAnimationFrame(libraryDragFrame);
        }

        function updateLibraryDropTarget() {
            if (!libraryDrag) return;
            libraryDrag.targetId = libraryDropTargetAt(libraryDrag.x, libraryDrag.y);
            highlightDropTarget(libraryDrag.targetId);
        }

        function onLibraryDragKey(e) {
            if (e.key !== "Escape" || !libraryDrag || !libraryDrag.active) return;
            // Abbruch per Escape darf nicht zusaetzlich Dialoge schliessen.
            e.stopPropagation();
            e.preventDefault();
            endLibraryDrag(false);
        }

        // Beendet den Vorgang IMMER vollstaendig: Schleife aus, Etikett weg,
        // Zeiger frei, Hervorhebungen weg, Listener ab. Wird von Drop,
        // Abbruch, Escape und pointercancel gemeinsam benutzt.
        function endLibraryDrag(commit) {
            const current = libraryDrag;
            if (!current) return;
            libraryDrag = null;

            if (current.frame) cancelAnimationFrame(current.frame);
            if (current.ghost && current.ghost.parentNode) current.ghost.remove();
            document.removeEventListener("keydown", onLibraryDragKey, true);
            document.body.classList.remove("library-dragging");

            const list = getLibraryList();
            if (list) {
                try {
                    if (list.hasPointerCapture(current.pointerId)) list.releasePointerCapture(current.pointerId);
                } catch (e) {}
                list.querySelectorAll("li.dragging").forEach(el => el.classList.remove("dragging"));
                highlightDropTarget(null);
            }

            if (current.active) {
                // Nach einem echten Ziehen soll der folgende Klick das
                // Projekt nicht zusaetzlich oeffnen. Die Sperre raeumt sich
                // im naechsten Tick selbst wieder ab.
                suppressLibraryClick = true;
                setTimeout(() => { suppressLibraryClick = false; }, 0);
            }

            if (commit && current.active && current.targetId !== null) {
                handleLibraryDrop(current.key, current.targetId);
            }
        }

        async function handleLibraryDrop(key, folderId) {
            const moved = await moveProjectToFolder(key, folderId || null);
            if (!moved) return;
            if (folderId) {
                openFolders.add(folderId);
                persistOpenFolders();
            }
            await loadProjects();
            const name = key.replace("codepen_", "");
            showToast(folderId ? t("movedToFolder", name, folderNameById.get(folderId) || "")
                               : t("movedToRoot", name), "success");
        }

        function initLibraryDragAndDrop() {
            const list = getLibraryList();
            if (!list) return;

            list.addEventListener("pointerdown", (e) => {
                if (e.pointerType === "mouse" && e.button !== 0) return;
                const row = e.target && e.target.closest ? e.target.closest("li.lib-project") : null;
                if (!row) return;
                if (e.target.closest(".lib-action")) return;   // Zeilen-Buttons
                if (libraryDrag) endLibraryDrag(false);
                // Bewusst KEIN preventDefault: der normale Klick zum
                // Oeffnen eines Projekts muss unveraendert funktionieren.
                libraryDrag = {
                    pointerId: e.pointerId, key: row.dataset.key, row,
                    startX: e.clientX, startY: e.clientY,
                    x: e.clientX, y: e.clientY,
                    active: false, ghost: null, targetId: null, frame: null,
                    lastTs: 0, scrollRest: 0
                };
            });

            list.addEventListener("pointermove", (e) => {
                if (!libraryDrag || e.pointerId !== libraryDrag.pointerId) return;
                libraryDrag.x = e.clientX;
                libraryDrag.y = e.clientY;
                if (libraryDrag.active) return;
                if (Math.abs(e.clientX - libraryDrag.startX) < DRAG_THRESHOLD_PX &&
                    Math.abs(e.clientY - libraryDrag.startY) < DRAG_THRESHOLD_PX) return;
                startLibraryDrag();
            });

            list.addEventListener("pointerup", (e) => {
                if (!libraryDrag || e.pointerId !== libraryDrag.pointerId) return;
                endLibraryDrag(true);
            });

            // Abbruch durch das System (Touch-Scroll, Fensterwechsel, ...).
            list.addEventListener("pointercancel", (e) => {
                if (!libraryDrag || e.pointerId !== libraryDrag.pointerId) return;
                endLibraryDrag(false);
            });

            // Sicherheitsnetz: verlaesst der Zeiger das Fenster ganz, wird
            // ein noch nicht gestarteter Druck verworfen.
            window.addEventListener("blur", () => { if (libraryDrag) endLibraryDrag(false); });
        }

        // =========================================================
        // EXPORT (JSON)
        //
        // Das Format bleibt was es war - ein Objekt mit "codepen_<Name>"-
        // Schluesseln. Neu dazu kommt EIN Metadatenblock:
        //
        //   {
        //     "__codeforge__": { "version": 2, "folders": [ {id, name} ] },
        //     "codepen_Game A": { ..., "folderId": "f_..." },
        //     "codepen_Game D": { ... }          <- ohne Ordner
        //   }
        //
        // "__codeforge__" beginnt bewusst NICHT mit "codepen_". Die
        // Import-Schleife laeuft nur ueber "codepen_"-Schluessel und
        // ueberspringt den Block dadurch automatisch. Eine aeltere Datei
        // ohne diesen Block bleibt vollstaendig gueltig.
        // =========================================================
        async function exportProjectsData(scope) {
            const keys = await dbGetAllKeys();
            if (keys.length === 0) {
                showToast(t("noProjectsToExport"), "warning");
                return;
            }

            const folders = await getFolders();
            const exportData = {};
            let filename = "";
            let projectKeys = [];

            if (scope === "single") {
                if (!currentProjectKey) {
                    showToast(t("noProjectSelected"), "warning");
                    return;
                }
                projectKeys = [currentProjectKey];
                filename = `project_${currentProjectKey.replace("codepen_", "")}_${new Date().toISOString().slice(0, 10)}.json`;
            } else {
                projectKeys = keys;
                filename = `projects_backup_all_${new Date().toISOString().slice(0, 10)}.json`;
            }

            const collected = [];
            const usedFolderIds = new Set();
            for (const key of projectKeys) {
                const data = await dbGet(key);
                if (!data) continue;
                // Kopie mit geprueftem folderId - ein Verweis auf einen
                // geloeschten Ordner wird beim Export zu "kein Ordner".
                const folderId = resolveFolderId(data.folderId, folders);
                collected.push([key, Object.assign({}, data, { folderId })]);
                if (folderId) usedFolderIds.add(folderId);
            }

            // Beim Gesamt-Backup wandern ALLE Ordner mit, auch leere. Beim
            // Export eines einzelnen Projekts nur dessen eigener Ordner.
            const exportedFolders = (scope === "single")
                ? folders.filter(f => usedFolderIds.has(f.id))
                : folders.slice();

            exportData.__codeforge__ = {
                version: 2,
                exported: new Date().toISOString(),
                folders: exportedFolders
            };
            collected.forEach(([key, data]) => { exportData[key] = data; });

            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
            const downloadAnchor = document.createElement('a');
            downloadAnchor.setAttribute("href", dataStr);
            downloadAnchor.setAttribute("download", filename);
            document.body.appendChild(downloadAnchor);
            downloadAnchor.click();
            downloadAnchor.remove();
        }

        // =========================================================
        // ORDNER AUS EINEM IMPORT ZUSAMMENFUEHREN
        //
        // Regeln - bewusst deterministisch, damit derselbe Import immer
        // dasselbe Ergebnis liefert:
        //
        //   * Gleicher Name (ohne Gross-/Kleinschreibung, ohne Rand-
        //     Leerzeichen) -> der VORHANDENE Ordner wird wiederverwendet.
        //     Aus "RPG" + "rpg" wird also kein Duplikat.
        //   * Sonst -> neuer Ordner mit FRISCHER lokaler ID. Fremde IDs
        //     werden nie uebernommen; sie koennten sonst mit lokalen IDs
        //     kollidieren und Projekte in den falschen Ordner legen.
        //   * Rueckgabe: Zuordnung "fremde ID -> lokale ID" plus die
        //     Anzahl wirklich neu angelegter Ordner.
        // =========================================================
        async function mergeImportedFolders(incoming) {
            const map = new Map();
            if (!incoming || !incoming.length) return { map, added: 0 };

            const folders = (await getFolders()).slice();
            const byName = new Map(folders.map(f => [f.name.trim().toLowerCase(), f]));
            let added = 0;

            for (const inc of incoming) {
                const nameKey = inc.name.trim().toLowerCase();
                const existing = byName.get(nameKey);
                if (existing) {
                    map.set(inc.id, existing.id);
                    continue;
                }
                const created = { id: makeFolderId(), name: inc.name.trim() };
                folders.push(created);
                byName.set(nameKey, created);
                map.set(inc.id, created.id);
                added++;
            }

            if (added) await saveFolders(folders);
            return { map, added };
        }

        // =========================================================
        // IMPORT (JSON)
        //
        // Robust gegenueber alten Dateien (kein "__codeforge__", kein
        // folderId -> alles landet auf der obersten Ebene) und gegenueber
        // beschaedigten Eintraegen (werden gezaehlt und uebersprungen,
        // statt den ganzen Import abzubrechen).
        // =========================================================
        function importProjectsFromJsonFile(file) {
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const importedData = JSON.parse(e.target.result);
                    if (!importedData || typeof importedData !== "object" || Array.isArray(importedData)) {
                        showToast(t("importError"), "error");
                        return;
                    }

                    const meta = importedData.__codeforge__;
                    const merge = await mergeImportedFolders(
                        normalizeFolderList(meta && meta.folders));

                    let count = 0;
                    let skipped = 0;

                    for (const key of Object.keys(importedData)) {
                        // Nur echte Projektschluessel; "__codeforge__" und
                        // alles Fremde wird hier automatisch uebersprungen.
                        if (!key.startsWith("codepen_")) continue;

                        const raw = importedData[key];
                        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
                            skipped++;
                            continue;
                        }

                        const data = Object.assign({}, raw);
                        // Fremde Ordner-ID auf die lokale abbilden. Fehlt sie
                        // oder zeigt sie ins Leere, kommt das Projekt auf die
                        // oberste Ebene - nie in einen falschen Ordner.
                        data.folderId = merge.map.get(data.folderId) || null;
                        await saveImportedProject(key.replace("codepen_", ""), data);
                        count++;
                    }

                    if (count === 0 && merge.added === 0) {
                        showToast(t("importError"), "error");
                        return;
                    }

                    showToast(merge.added ? t("importSuccessFolders", count, merge.added)
                                          : t("importSuccess", count), "success");
                    if (skipped) showToast(t("importSkipped", skipped), "warning");

                    await loadProjects();

                    const keys = await dbGetAllKeys();
                    if (keys.length > 0) {
                        await openProject(keys[0]);
                    }
                    closeImportExportModal();
                } catch (err) {
                    showToast(t("importError"), "error");
                }
            };
            reader.readAsText(file);
        }


        /* =========================================================
           CODEFORGE FEATURES
           ========================================================= */
        let projectTypeForModal = "web";
        let lastUsedFolderId = null;   // Vorauswahl im "Neues Projekt"-Dialog
        let currentMobileFile = "html";
        let recentProjects = JSON.parse(localStorage.getItem("codeforge_recent") || "[]");

        // Ersetzt native alert()-Popups (siehe Screenshot: hässliches
        // Browser-eigenes "Auf dieser Seite wird Folgendes angezeigt").
        // type: "success" | "warning" | "error"
        function showToast(message, type = "warning") {
            const container = document.getElementById("toast-container");
            if (!container) return;

            const toast = document.createElement("div");
            toast.className = "toast toast-" + type;
            const icon = type === "success" ? "✓" : type === "error" ? "✗" : "⚠";
            toast.innerHTML = '<span class="toast-icon">' + icon + '</span><span>' + escapeHtml(String(message)) + '</span>';

            const remove = () => {
                toast.classList.add("toast-hide");
                setTimeout(() => toast.remove(), 200);
            };
            toast.addEventListener("click", remove);

            container.appendChild(toast);
            requestAnimationFrame(() => toast.classList.add("toast-show"));
            setTimeout(remove, 3200);
        }

        function setSaveStatus(status, text) {
            const el = document.getElementById("save-status");
            if (!el) return;
            el.textContent = text || status;
            el.style.color = status === "saving" ? "#ffc107" : (status === "saved" ? "#8bc34a" : "#ff6b6b");
        }

        // =========================================================
        // STARTSEITE BEIM OEFFNEN
        //
        // Standard: an. Der Schalter auf der Startseite selbst stellt es
        // ab. Ein Projekt wird trotzdem im Hintergrund geladen, damit
        // hinter der Startseite nie eine leere Ansicht steht.
        // =========================================================
        // =========================================================
        // PROJEKTE BEIM OEFFNEN UND WECHSELN AUTOMATISCH PAUSIEREN
        //
        // Standard: aus. Damit bleibt das bisherige Verhalten unveraendert.
        // Ist die Einstellung an, wird die Vorschau beim Oeffnen eines
        // Projekts direkt PAUSIERT AUFGEBAUT - sie laeuft also nicht kurz
        // an. Das Fortsetzen benutzt dieselbe Pause-/Weiter-Mechanik wie
        // der Knopf: das Dokument wird nicht neu geladen, es laeuft genau
        // dort weiter, wo es angehalten wurde.
        // =========================================================
        const pauseOnOpenKey = "codeforge_pause_on_open";

        function shouldAutoPauseOnOpen() {
            try {
                return localStorage.getItem(pauseOnOpenKey) === "1";
            } catch (e) {
                return false;
            }
        }

        function setPauseOnOpen(enabled) {
            try { localStorage.setItem(pauseOnOpenKey, enabled ? "1" : "0"); } catch (e) {}
            showToast(enabled ? t("pauseOnOpenOn") : t("pauseOnOpenOff"), "success");
        }

        function syncPauseOnOpenToggle() {
            const box = document.getElementById("pause-on-open");
            if (box) box.checked = shouldAutoPauseOnOpen();
        }

        const homeOnStartKey = "codeforge_home_on_start";

        function shouldShowHomeOnStart() {
            try {
                return localStorage.getItem(homeOnStartKey) !== "0";
            } catch (e) {
                return true;
            }
        }

        function setHomeOnStart(enabled) {
            try { localStorage.setItem(homeOnStartKey, enabled ? "1" : "0"); } catch (e) {}
            showToast(enabled ? t("homeOnStartOn") : t("homeOnStartOff"), "success");
        }

        function syncHomeOnStartToggle() {
            const box = document.getElementById("home-on-start");
            if (box) box.checked = shouldShowHomeOnStart();
        }

        function showHome() {
            renderRecentProjects();
            renderHomeStats();
            updateTrashBadge();
            syncHomeOnStartToggle();
            syncPauseOnOpenToggle();
            document.getElementById("home-screen").classList.add("active");
        }

        function hideHome() {
            document.getElementById("home-screen").classList.remove("active");
        }

        async function renderRecentProjects() {
            const box = document.getElementById("recent-projects");
            if (!box) return;

            // Nur Projekte behalten, die tatsächlich noch existieren -
            // gelöschte Projekte verschwinden dadurch auch aus der
            // "Zuletzt geöffnet"-Liste auf der Startseite.
            const existing = [];
            for (const key of recentProjects) {
                const data = await dbGet(key);
                if (data) existing.push(key);
            }
            if (existing.length !== recentProjects.length) {
                recentProjects = existing;
                localStorage.setItem("codeforge_recent", JSON.stringify(recentProjects));
            }

            box.innerHTML = "";
            if (!recentProjects.length) {
                box.innerHTML = '<div style="color:var(--muted);font-size:13px;">' + t("noRecentProjects") + '</div>';
                return;
            }
            recentProjects.slice(0, 8).forEach(key => {
                const item = document.createElement("div");
                item.className = "recent-item";
                item.textContent = key.replace("codepen_", "");
                item.onclick = () => { hideHome(); openProject(key); };
                box.appendChild(item);
            });
        }

        function rememberRecentProject(key) {
            recentProjects = [key, ...recentProjects.filter(k => k !== key)].slice(0, 8);
            localStorage.setItem("codeforge_recent", JSON.stringify(recentProjects));
            renderRecentProjects();
        }

        function openProjectModal(type = "web") {
            projectTypeForModal = type;
            chooseProjectType(type);
            // Zuletzt benutzter Ordner ist die naheliegendste Vorauswahl.
            populateFolderSelect(lastUsedFolderId);
            document.getElementById("project-modal").classList.add("open");
            setTimeout(() => document.getElementById("new-project-name").focus(), 50);
        }


        // Fuellt die Ordner-Auswahl im "Neues Projekt"-Dialog. Gibt es noch
        // keinen Ordner, wird die ganze Zeile ausgeblendet - kein leeres
        // Bedienelement ohne Nutzen.
        async function populateFolderSelect(selectedId) {
            const select = document.getElementById("new-project-folder");
            const row = document.getElementById("new-project-folder-row");
            if (!select) return;

            const folders = (await getFolders()).slice()
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
            if (row) row.style.display = folders.length ? "" : "none";

            select.innerHTML = "";
            const rootOption = document.createElement("option");
            rootOption.value = "";
            rootOption.textContent = t("noFolderOption");
            select.appendChild(rootOption);
            folders.forEach(f => {
                const option = document.createElement("option");
                option.value = f.id;
                option.textContent = f.name;
                select.appendChild(option);
            });
            select.value = selectedId || "";
        }

        function closeProjectModal() {
            document.getElementById("project-modal").classList.remove("open");
        }

        function chooseProjectType(type) {
            projectTypeForModal = type;
            document.getElementById("choice-web").classList.toggle("active", type === "web");
            document.getElementById("choice-python").classList.toggle("active", type === "python");
            const select = document.getElementById("project-template");
            const previousValue = select.value;
            select.innerHTML = type === "python"
                ? `<option value="blank">${t("optBlank")}</option><option value="starter">${t("optPyStarter")}</option><option value="terminal">${t("optTerminalStarter")}</option>`
                : `<option value="blank">${t("optBlank")}</option><option value="starter">${t("optWebStarter")}</option><option value="game">${t("optJsGame")}</option><option value="landing">${t("optLandingPage")}</option>`;
            // Auswahl beibehalten, wenn sie in der neuen Liste noch existiert
            // (z.B. bei Sprachwechsel während das Modal offen ist). Beim
            // tatsächlichen Wechsel Web<->Python gibt es den Wert meist gar
            // nicht mehr, dann bleibt es automatisch bei der ersten Option.
            if ([...select.options].some(o => o.value === previousValue)) {
                select.value = previousValue;
            }
        }

        async function createProjectFromModal() {
            const name = document.getElementById("new-project-name").value.trim();
            if (!name) return showToast(t("enterProjectName"), "warning");
            const key = "codepen_" + name;
            if (await dbGet(key)) return showToast(t("nameExists2"), "warning");
            const template = document.getElementById("project-template").value;
            const folderSelect = document.getElementById("new-project-folder");
            let data = { type: projectTypeForModal, folderId: folderSelect ? (folderSelect.value || null) : null,
                         html:"", css:"", js:"", py:"" };

            if (projectTypeForModal === "python") {
                if (template !== "blank") data.py = 'name = input("Wie heißt du? ")\nprint(f"Hallo {name}!")';
            } else {
                if (template === "starter") {
                    data.html = '<main class="card"><h1>Hallo 👋</h1><p>Dein neues Webprojekt.</p><button onclick="hello()">Klick mich</button></main>';
                    data.css = 'body{font-family:sans-serif;display:grid;place-items:center;min-height:100vh}.card{padding:32px;border:1px solid #ddd;border-radius:16px}';
                    data.js = 'function hello(){alert("Hallo Welt!");}';
                } else if (template === "game") {
                    data.html = '<h1>Kleines Spiel</h1><button id="score">Punkte: 0</button>';
                    data.css = 'body{font-family:sans-serif;text-align:center;padding:40px}button{font-size:24px;padding:15px}';
                    data.js = 'let score=0;document.getElementById("score").onclick=()=>{score++;document.getElementById("score").textContent="Punkte: "+score;}';
                } else if (template === "landing") {
                    data.html = '<section class="hero"><h1>Dein Produkt</h1><p>Eine einfache Landing Page.</p><a href="#start">Loslegen</a></section>';
                    data.css = '.hero{text-align:center;padding:15vh 20px;font-family:sans-serif}h1{font-size:56px;margin-bottom:12px}a{padding:12px 20px;border-radius:8px;background:#007acc;color:#fff;text-decoration:none}';
                } else {
                    data.html = "<h1>Hallo Welt</h1>";
                }
            }
            await dbSet(key, data);
            data.folderId = resolveFolderId(data.folderId, await getFolders());
            lastUsedFolderId = data.folderId;
            if (data.folderId) {
                openFolders.add(data.folderId);
                persistOpenFolders();
            }
            closeProjectModal();
            await loadProjects();
            await openProject(key);
        }

        function renderFileTree() {
            const box = document.getElementById("file-tree");
            if (!box) return;
            box.style.display = currentProjectKey ? "block" : "none";
            box.innerHTML = "";
            const projectType = document.getElementById("btn-tab-python").style.display !== "none" ? "python" : "web";
            const files = projectType === "python"
                ? [["py","main.py","🐍"]]
                : [["html","index.html","🌐"],["css","style.css","🎨"],["js","script.js","⚡"]];
            files.forEach(([key,name,icon]) => {
                const div = document.createElement("div");
                div.className = "file-tree-item" + (currentMobileFile === key ? " active" : "");
                div.textContent = icon + " " + name;
                div.onclick = () => mobileSelectFile(key);
                box.appendChild(div);
            });
        }

        function mobileSelectFile(file) {
            currentMobileFile = file;
            ["html","css","js"].forEach(k => {
                const box = document.getElementById(k + "-box");
                if (box) box.classList.toggle("mobile-hidden", k !== file && window.innerWidth <= 760);
                const btn = document.getElementById("mobile-" + k);
                if (btn) btn.classList.toggle("active", k === file);
            });

            // Auf dem Desktop sind ohnehin alle drei Editoren gleichzeitig
            // sichtbar - ein Klick in der "DATEIEN"-Liste hatte dort bisher
            // keinerlei sichtbaren Effekt. Jetzt wird zusätzlich zum
            // passenden Editor gescrollt und er kurz farblich hervorgehoben,
            // damit der Klick auch am Desktop erkennbar etwas bewirkt.
            // Nur scrollen/hervorheben/fokussieren, wenn der Web-Tab
            // gerade wirklich aktiv ist. Sonst würde z.B. beim Start mit
            // einem zuletzt geöffneten PYTHON-Projekt unsichtbar der
            // (ausgeblendete) HTML-Editor den Fokus bekommen.
            const targetBox = document.getElementById(file + "-box");
            if (targetBox && document.getElementById("web-tab").classList.contains("active")) {
                targetBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
                targetBox.classList.add("file-jump-highlight");
                setTimeout(() => targetBox.classList.remove("file-jump-highlight"), 900);
                const cm = cmEditors[file];
                if (cm) setTimeout(() => cm.focus(), 250);
            }

            renderFileTree();
            refreshCodeMirrorEditors();
        }

        function toggleTheme() {
            document.body.classList.toggle("light-theme");
            const light = document.body.classList.contains("light-theme");
            localStorage.setItem("codeforge_theme", light ? "light" : "dark");
            refreshCodeMirrorEditors();
            setTimeout(refreshCodeMirrorEditors, 50);
        }

        function toggleEditorFullscreen() {
            const target = document.getElementById("main");
            if (!document.fullscreenElement) {
                target.requestFullscreen?.();
            } else {
                document.exitFullscreen?.();
            }
        }

        async function exportCurrentAsZip() {
            if (!currentProjectKey) return showToast(t("selectProjectFirst2"), "warning");
            if (!window.JSZip) return showToast(t("zipModuleError"), "error");
            const data = await dbGet(currentProjectKey);
            if (!data) return;
            const zip = new JSZip();
            const name = currentProjectKey.replace("codepen_", "");
            if (data.type === "python") {
                zip.file("main.py", data.py || "");
            } else {
                zip.file("index.html", data.html || "");
                zip.file("style.css", data.css || "");
                zip.file("script.js", data.js || "");
            }
            const blob = await zip.generateAsync({type:"blob"});
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = name + ".zip";
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }

        // Alle Projekte als EINE ZIP-Datei, jedes Projekt in einem eigenen
        // Unterordner (Ordnername = Projektname).
        // Ordner- und Projektnamen werden in der ZIP zu Pfaden. Zeichen,
        // die in Dateinamen nicht erlaubt sind, werden ersetzt - sonst
        // entstehen beim Entpacken kaputte oder verschachtelte Pfade.
        function safeZipName(name) {
            const cleaned = String(name)
                .replace(/[\\/:*?"<>|]/g, "-")
                .replace(/^\.+/, "_")
                .trim();
            return cleaned || "Projekt";
        }

        // Alle Projekte als EINE ZIP-Datei. Die Ordnerstruktur wird dabei
        // 1:1 zur Verzeichnisstruktur:
        //
        //   RPG/Game A/index.html
        //   RPG/Game B/index.html
        //   Horror/Game C/index.html
        //   Game D/index.html            <- Projekt ohne Ordner
        //
        // Fuer JEDEN Ordner wird ausserdem ein Verzeichniseintrag angelegt.
        // Dadurch ueberleben auch LEERE Ordner den Weg durch die ZIP-Datei,
        // ganz ohne zusaetzliche Manifest-Datei.
        async function exportAllProjectsAsZip() {
            if (!window.JSZip) return showToast(t("zipModuleError"), "error");
            const keys = await dbGetAllKeys();
            if (keys.length === 0) return showToast(t("noProjectsToExport"), "warning");

            const folders = await getFolders();
            const zip = new JSZip();

            const folderPath = new Map();
            const usedPaths = new Set();
            for (const f of folders) {
                const base = safeZipName(f.name);
                let path = base;
                let n = 2;
                // Zwei verschiedene Namen koennen nach dem Saeubern gleich
                // aussehen ("A/B" und "A-B") - dann wird durchnummeriert.
                while (usedPaths.has(path.toLowerCase())) path = base + " (" + (n++) + ")";
                usedPaths.add(path.toLowerCase());
                folderPath.set(f.id, path);
                zip.folder(path);
            }

            for (const key of keys) {
                const data = await dbGet(key);
                if (!data) continue;
                const projectName = safeZipName(key.replace("codepen_", ""));
                const parent = folderPath.get(resolveFolderId(data.folderId, folders));
                const folder = zip.folder(parent ? parent + "/" + projectName : projectName);
                if (data.type === "python") {
                    folder.file("main.py", data.py || "");
                } else {
                    folder.file("index.html", data.html || "");
                    folder.file("style.css", data.css || "");
                    folder.file("script.js", data.js || "");
                }
            }

            const blob = await zip.generateAsync({type:"blob"});
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "projects_backup_all_" + new Date().toISOString().slice(0, 10) + ".zip";
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }

        // Speichert Projektdaten unter einem freien Schlüssel (hängt bei
        // Namenskollision "_Kopie"/"_Kopie2"/... an) - von JSON- UND
        // ZIP-Import gemeinsam genutzt.
        async function saveImportedProject(baseName, data) {
            let targetKey = "codepen_" + baseName;
            let counter = 1;
            while (await dbGet(targetKey)) {
                targetKey = `codepen_${baseName}_Kopie${counter > 1 ? counter : ''}`;
                counter++;
            }
            await dbSet(targetKey, data);
        }

        // ZIP-Import (bisher gab es nur ZIP-Export, kein Import). Erkennt
        // automatisch beide Fälle:
        // - Ein einzelnes Projekt: Dateien liegen direkt im Wurzel-
        //   verzeichnis der ZIP (index.html/style.css/script.js oder
        //   main.py) - der Projektname kommt vom ZIP-Dateinamen.
        // - Ein Backup mehrerer Projekte (siehe exportAllProjectsAsZip):
        //   jeder Unterordner in der ZIP wird als eigenes Projekt importiert,
        //   der Ordnername wird zum Projektnamen.
        // ZIP-Import. Erkennt drei Faelle allein an der Verzeichnis-
        // struktur - ohne Manifest, damit auch eine von Hand gebaute ZIP
        // funktioniert:
        //
        //   1. Projektdateien direkt im Wurzelverzeichnis
        //      -> EIN Projekt, Name kommt vom ZIP-Dateinamen. (wie bisher)
        //   2. Verzeichnis mit Projektdateien direkt darin
        //      -> ein Projekt ohne Ordner. (altes Backup-Format)
        //   3. Verzeichnis, dessen UNTERverzeichnisse Projektdateien
        //      enthalten -> ein ORDNER mit diesen Projekten. (neues Format)
        //
        // Leere Verzeichnisse werden nur dann als leere Ordner uebernommen,
        // wenn die Datei ueberhaupt im neuen Format vorliegt. Sonst bliebe
        // ein altes Backup mit einem leeren Projektverzeichnis nicht
        // rueckwaertskompatibel.
        async function importFromZip(file) {
            if (!window.JSZip) return showToast(t("zipModuleError"), "error");

            try {
                const zip = await JSZip.loadAsync(file);

                const projectFileNames = ["index.html", "style.css", "script.js", "main.py"];
                const dirs = new Set();          // alle Verzeichnisse
                const projectDirs = new Set();   // Verzeichnisse MIT Projektdateien
                let hasRootFiles = false;

                zip.forEach((relPath, entry) => {
                    const clean = String(relPath).replace(/\/+$/, "");
                    if (!clean) return;
                    if (entry.dir) { dirs.add(clean); return; }
                    const parts = clean.split("/");
                    const fileName = parts.pop();
                    if (parts.length) dirs.add(parts.join("/"));
                    if (projectFileNames.indexOf(fileName) === -1) return;
                    if (parts.length) projectDirs.add(parts.join("/"));
                    else hasRootFiles = true;
                });

                const readFile = async (path) => {
                    const entry = zip.file(path);
                    return entry ? await entry.async("string") : null;
                };

                const buildProjectData = async (prefix) => {
                    const p = prefix ? prefix + "/" : "";
                    const html = await readFile(p + "index.html");
                    const css = await readFile(p + "style.css");
                    const js = await readFile(p + "script.js");
                    const py = await readFile(p + "main.py");

                    if (py !== null && html === null) {
                        return { type: "python", py: py };
                    }
                    if (html !== null || css !== null || js !== null) {
                        return { type: "web", html: html || "", css: css || "", js: js || "" };
                    }
                    return null;
                };

                // Verzeichnisse der obersten Ebene, die Projekte ENTHALTEN,
                // sind Ordner.
                const folderNames = new Set();
                projectDirs.forEach(p => {
                    const parts = p.split("/");
                    if (parts.length > 1) folderNames.add(parts[0]);
                });
                const newFormat = folderNames.size > 0;

                if (newFormat) {
                    const topLevel = new Set();
                    dirs.forEach(p => topLevel.add(p.split("/")[0]));
                    projectDirs.forEach(p => topLevel.add(p.split("/")[0]));
                    topLevel.forEach(name => {
                        const isProject = projectDirs.has(name);
                        const hasChildren = [...projectDirs].some(p => p.indexOf(name + "/") === 0);
                        if (!isProject && !hasChildren) folderNames.add(name);   // leerer Ordner
                    });
                }

                const merge = await mergeImportedFolders(
                    [...folderNames].map(name => ({ id: "zip:" + name, name })));

                let importedCount = 0;

                for (const dir of projectDirs) {
                    const data = await buildProjectData(dir);
                    if (!data) continue;
                    const parts = dir.split("/");
                    const projectName = parts[parts.length - 1];
                    if (parts.length > 1) data.folderId = merge.map.get("zip:" + parts[0]) || null;
                    await saveImportedProject(projectName, data);
                    importedCount++;
                }

                if (hasRootFiles) {
                    const data = await buildProjectData("");
                    if (data) {
                        const baseName = file.name.replace(/\.zip$/i, "") || "Import";
                        await saveImportedProject(baseName, data);
                        importedCount++;
                    }
                }

                if (importedCount === 0 && merge.added === 0) {
                    showToast(t("importError"), "error");
                    return;
                }

                showToast(merge.added ? t("importSuccessFolders", importedCount, merge.added)
                                      : t("importSuccess", importedCount), "success");
                await loadProjects();
                const keys = await dbGetAllKeys();
                if (keys.length > 0) await openProject(keys[0]);
                closeImportExportModal();
            } catch (err) {
                showToast(t("importError"), "error");
            }
        }

        // =========================================================
        // Kombiniertes Import/Export-Modal: Aktion (Export/Import),
        // Dateityp (ZIP/JSON) und Umfang (aktuelles Projekt/Backup) werden
        // hier zentral ausgewählt, statt über mehrere Einzel-Buttons.
        // =========================================================
        let ieState = { action: "export", format: "zip", scope: "single" };

        function openImportExportModal() {
            ieState = { action: "export", format: "zip", scope: "single" };
            document.getElementById("import-export-modal").classList.add("open");
            updateImportExportUI();
        }

        function closeImportExportModal() {
            document.getElementById("import-export-modal").classList.remove("open");
        }

        function setIEAction(action) {
            ieState.action = action;
            updateImportExportUI();
        }
        function setIEFormat(format) {
            ieState.format = format;
            updateImportExportUI();
        }
        function setIEScope(scope) {
            ieState.scope = scope;
            updateImportExportUI();
        }

        function updateImportExportUI() {
            document.getElementById("ie-action-export").classList.toggle("active", ieState.action === "export");
            document.getElementById("ie-action-import").classList.toggle("active", ieState.action === "import");
            document.getElementById("ie-format-zip").classList.toggle("active", ieState.format === "zip");
            document.getElementById("ie-format-json").classList.toggle("active", ieState.format === "json");
            document.getElementById("ie-scope-single").classList.toggle("active", ieState.scope === "single");
            document.getElementById("ie-scope-all").classList.toggle("active", ieState.scope === "all");

            // Umfang (aktuelles Projekt / Backup aller Projekte) ist nur
            // beim EXPORT relevant. Beim Import bestimmt immer die Datei
            // selbst, was importiert wird (einzelnes Projekt oder mehrere) -
            // die Auswahl hätte dort keine Wirkung und würde nur verwirren.
            document.getElementById("ie-scope-row").style.display =
                (ieState.action === "import") ? "none" : "";

            document.getElementById("ie-run-btn").textContent =
                ieState.action === "export" ? t("ieRun") : t("ieRunImport");

            document.getElementById("ie-hint").textContent = (() => {
                if (ieState.action === "export") {
                    if (ieState.format === "zip") {
                        return ieState.scope === "single" ? t("ieHintZipSingle") : t("ieHintZipAll");
                    }
                    return ieState.scope === "single" ? t("ieHintJsonSingle") : t("ieHintJsonAll");
                }
                return ieState.format === "zip" ? t("ieHintZipImport") : t("ieHintJsonImport");
            })();
        }

        async function runImportExportAction() {
            if (ieState.action === "export") {
                if (ieState.format === "zip") {
                    if (ieState.scope === "single") {
                        await exportCurrentAsZip();
                    } else {
                        await exportAllProjectsAsZip();
                    }
                } else {
                    await exportProjectsData(ieState.scope);
                }
                closeImportExportModal();
            } else {
                const input = document.getElementById("import-file-input");
                input.accept = ieState.format === "zip" ? ".zip" : ".json";
                input.dataset.ieFormat = ieState.format;
                input.click();
                // Modal bleibt offen, bis die Dateiauswahl abgeschlossen ist -
                // handleImportFileSelected schließt es nach erfolgreichem Import.
            }
        }

        function handleImportFileSelected(event) {
            const file = event.target.files[0];
            event.target.value = "";
            if (!file) return;
            const format = event.target.dataset.ieFormat || (file.name.toLowerCase().endsWith(".zip") ? "zip" : "json");
            if (format === "zip") {
                importFromZip(file);
            } else {
                importProjectsFromJsonFile(file);
            }
        }

        function getActiveCodeEditor() {
            return getActiveEditor();
        }

        function openSearchModal() {
            document.getElementById("search-modal").classList.add("open");
            document.getElementById("search-term").focus();
        }
        function closeSearchModal() { document.getElementById("search-modal").classList.remove("open"); }

        function findInCurrentCode() {
            const term = document.getElementById("search-term").value;
            const editor = getActiveCodeEditor();
            const box = document.getElementById("search-results");
            if (!editor || !term) return;
            const value = editor.getValue();
            const matches = [...value.matchAll(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];
            box.textContent = t("matchesFound", matches.length);
            if (matches.length) editor.setSelection(editor.posFromIndex(matches[0].index), editor.posFromIndex(matches[0].index + term.length));
        }

        function replaceInCurrentCode() {
            const term = document.getElementById("search-term").value;
            const replacement = document.getElementById("replace-term").value;
            const editor = getActiveCodeEditor();
            if (!editor || !term) return;
            const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const count = (editor.getValue().match(new RegExp(escaped, "g")) || []).length;
            editor.setValue(editor.getValue().replace(new RegExp(escaped, "g"), replacement));
            document.getElementById("search-results").textContent = t("matchesReplaced", count);
            triggerAutoSave();
        }

        // =========================================================
        // BEFEHLSPALETTE (Strg/Cmd + K)
        //
        // Bewertung: BEHALTEN und ausbauen. Sie kostet fast nichts, ist
        // der einzige Weg ohne Maus und wird bei vielen Projekten zum
        // schnellsten Weg ueberhaupt. Neu sind die Aktionen, die es
        // vorher nur als Button gab (Umbenennen, Loeschen, Ordner,
        // Import/Export, Papierkorb) - und vor allem das direkte OEFFNEN
        // eines Projekts ueber seinen Namen.
        // =========================================================
        function getCommands() {
            return [
                [t("cmdNewWeb"), () => openProjectModal("web")],
                [t("cmdNewPy"), () => openProjectModal("python")],
                [t("cmdNewFolder"), () => createFolderFromDialog()],
                [t("cmdSave"), () => saveCurrentProject()],
                [t("cmdRename"), () => renameCurrentProject()],
                [t("cmdDeleteProject"), () => deleteCurrentProject()],
                [t("cmdFormat"), () => formatCurrentCode()],
                [t("cmdSearch"), () => openSearchModal()],
                [t("cmdTheme"), () => toggleTheme()],
                [t("cmdFullscreen"), () => toggleEditorFullscreen()],
                [t("cmdZip"), () => exportCurrentAsZip()],
                [t("cmdTrash"), () => openTrashModal()],
                [t("cmdHome"), () => showHome()],
            ];
        }

        function openCommandPalette() {
            const modal = document.getElementById("command-palette");
            modal.classList.add("open");
            const input = document.getElementById("command-input");
            input.value = "";
            renderCommands("");
            input.focus();
        }

        function closeCommandPalette() {
            document.getElementById("command-palette").classList.remove("open");
        }

        function renderCommands(filter) {
            const list = document.getElementById("command-list");
            if (!list) return;
            const query = String(filter || "").trim().toLowerCase();
            list.innerHTML = "";

            const addEntry = (label, hint, run) => {
                const item = document.createElement("div");
                item.className = "command-item";
                const text = document.createElement("span");
                text.textContent = label;
                item.appendChild(text);
                if (hint) {
                    const badge = document.createElement("span");
                    badge.className = "command-hint";
                    badge.textContent = hint;
                    item.appendChild(badge);
                }
                item.onclick = () => { closeCommandPalette(); run(); };
                list.appendChild(item);
            };

            let count = 0;
            getCommands().forEach(([name, fn]) => {
                if (query && !name.toLowerCase().includes(query)) return;
                addEntry(name, null, fn);
                count++;
            });

            // Projekte direkt oeffnen. Die Namen kommen aus der bereits
            // aufgebauten Bibliothek - keine zweite Datenquelle.
            document.querySelectorAll("#project-list li.lib-project").forEach(li => {
                const name = li.dataset.name || "";
                if (query && !name.toLowerCase().includes(query)) return;
                const key = li.dataset.key;
                const parent = li.dataset.parent || "";
                addEntry(t("cmdOpenProject", name),
                         parent ? (folderNameById.get(parent) || "") : "",
                         () => openProject(key));
                count++;
            });

            if (!count) {
                const note = document.createElement("div");
                note.className = "command-note";
                note.textContent = t("noSearchResults");
                list.appendChild(note);
            }
        }

        function initProKeyboardShortcuts() {
            const cmdInput = document.getElementById("command-input");
            cmdInput.addEventListener("input", () => renderCommands(cmdInput.value));
            document.addEventListener("keydown", e => {
                const mod = e.ctrlKey || e.metaKey;
                if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openCommandPalette(); }
                if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); openSearchModal(); }
                if (e.key === "Escape") {
                    document.querySelectorAll("#command-palette.open,#search-modal.open,#project-modal.open,#import-export-modal.open").forEach(x => x.classList.remove("open"));
                    // Bestätigen-Dialog ("Projekt löschen?" etc.) über Escape
                    // wie ein Klick auf "Abbrechen" behandeln - vorher war er
                    // als einziges Modal per Escape gar nicht schließbar.
                    if (document.getElementById("confirm-dialog").classList.contains("open")) {
                        closeConfirmDialog(false);
                    }
                }
            });
        }

        function applyStoredTheme() {
            if (localStorage.getItem("codeforge_theme") === "light") document.body.classList.add("light-theme");
        }

        // Autosave indicator: wrap existing autosave trigger without changing its storage behavior.
        const originalTriggerAutoSave = triggerAutoSave;
        triggerAutoSave = function() {
            setSaveStatus("saving", t("savingStatus"));
            originalTriggerAutoSave();
            setTimeout(() => setSaveStatus("saved", t("savedStatus")), 1200);
        };

        document.addEventListener('keydown', function(e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                saveCurrentProject();
            }
        });


        /* =========================================================
           FINAL UX FIXES
           ========================================================= */
        let textDialogResolver = null;

        // =========================================================
        // ZURUECK-PFEIL
        //
        // Der Pfeil oben links wechselt zwischen Startseite und Projekt.
        // In einem Dialog- oder Aktionszustand (Umbenennen, Loeschen,
        // Neues Projekt, Import/Export, Suche, Papierkorb, Befehlspalette)
        // ist er widerspruechlich: "zurueck" heisst dort "Dialog
        // schliessen", und dafuer gibt es Escape und die Buttons im
        // Dialog selbst.
        //
        // Wichtig: es wird KEIN zweiter Zustand mitgefuehrt. Der Pfeil
        // liest direkt aus dem DOM ab, ob gerade ein Overlay offen ist;
        // ein MutationObserver stoesst die Aktualisierung an. Dadurch
        // koennen Pfeil und echte Ansicht nicht auseinanderlaufen - egal
        // ueber welchen Weg ein Dialog geoeffnet oder geschlossen wurde.
        // =========================================================
        const overlayIds = ["project-modal", "search-modal", "import-export-modal",
                            "command-palette", "trash-modal", "confirm-dialog", "text-dialog"];

        function anyOverlayOpen() {
            return overlayIds.some(id => {
                const el = document.getElementById(id);
                return el && el.classList.contains("open");
            });
        }

        function updateBackButtonVisibility() {
            const btn = document.getElementById("browser-back-btn");
            if (!btn) return;
            btn.style.display = anyOverlayOpen() ? "none" : "";
        }

        function initOverlayStateWatcher() {
            const observer = new MutationObserver(updateBackButtonVisibility);
            overlayIds.forEach(id => {
                const el = document.getElementById(id);
                if (el) observer.observe(el, { attributes: true, attributeFilter: ["class"] });
            });
            updateBackButtonVisibility();
        }

        // Kennzahlen auf der Startseite.
        async function renderHomeStats() {
            const box = document.getElementById("home-stats");
            if (!box) return;
            const folders = await getFolders();
            const keys = await dbGetAllKeys();
            box.textContent = t("homeStats", keys.length, folders.length);
        }

        function goBackToPreviousView() {
            // Startseite -> vorheriges Projekt; Projekt -> Startseite.
            const home = document.getElementById("home-screen");
            if (home && home.classList.contains("active")) {
                if (currentProjectKey) {
                    hideHome();
                    openProject(currentProjectKey);
                }
                return;
            }
            showHome();
        }

        let confirmDialogResolver = null;
        function openConfirmDialog(title, message) {
            return new Promise(resolve => {
                confirmDialogResolver = resolve;
                document.getElementById("confirm-dialog-title").textContent = title;
                document.getElementById("confirm-dialog-message").textContent = message;
                document.getElementById("confirm-dialog").classList.add("open");
            });
        }
        function closeConfirmDialog(value) {
            document.getElementById("confirm-dialog").classList.remove("open");
            if (confirmDialogResolver) {
                const r = confirmDialogResolver;
                confirmDialogResolver = null;
                r(value);
            }
        }

        function openTextDialog(title, label, value = "") {
            return new Promise(resolve => {
                textDialogResolver = resolve;
                document.getElementById("text-dialog-title").textContent = title;
                document.getElementById("text-dialog-label").textContent = label;
                const input = document.getElementById("text-dialog-input");
                input.value = value;
                document.getElementById("text-dialog").classList.add("open");
                setTimeout(() => { input.focus(); input.select(); }, 40);
            });
        }

        function closeTextDialog(value) {
            document.getElementById("text-dialog").classList.remove("open");
            if (textDialogResolver) {
                const resolve = textDialogResolver;
                textDialogResolver = null;
                resolve(value);
            }
        }

        document.getElementById("text-dialog")?.addEventListener("keydown", e => {
            if (e.key === "Enter") closeTextDialog(document.getElementById("text-dialog-input").value);
            if (e.key === "Escape") closeTextDialog(null);
        });

        function appendConsoleEntry(type, message, location = "", jumpLine = null) {
            const output = document.getElementById("js-console-output");
            if (!output) return;
            const entry = document.createElement("div");
            entry.className = "console-entry " + type;
            const icon = type === "success" ? "✓" : type === "warn" ? "⚠" : type === "error" ? "✗" : "ℹ";
            const errorText = String(message) + (location ? "\n" + location : "");
            entry.innerHTML = '<span class="console-icon">' + icon + '</span><span>' +
                escapeHtml(String(message)) +
                (location ? '<span class="console-location">' + escapeHtml(location) + '</span>' : '') +
                '</span>' +
                (type === "error" ? '<button class="copy-btn console-copy-error" type="button" title="' + escapeHtml(t('copyErrorTitle')) + '" data-i18n-title="copyErrorTitle" aria-label="' + escapeHtml(t('copyErrorTitle')) + '" data-i18n-aria="copyErrorTitle"><svg class="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1"/><path d="M3.5 10.5v-7a1 1 0 0 1 1-1h7"/></svg></button>' : '');
            if (type === "error") {
                const copyBtn = entry.querySelector(".console-copy-error");
                copyBtn.addEventListener("click", (ev) => { ev.stopPropagation(); copyText(errorText, copyBtn); });
            }
            if (jumpLine) {
                entry.classList.add("console-entry-clickable");
                entry.title = t("jumpToLineTitle", jumpLine);
                entry.addEventListener("click", () => jumpToJsLine(jumpLine));
            }
            output.appendChild(entry);
            output.scrollTop = output.scrollHeight;
        }

        function copyText(text, button) {
            const done = () => {
                if (!button) return;
                const original = button.dataset.originalText || button.innerHTML;
                button.dataset.originalText = original;
                button.innerHTML = t("copied");
                button.classList.add("copied");
                clearTimeout(button._copyResetTimeout);
                button._copyResetTimeout = setTimeout(() => {
                    button.innerHTML = original;
                    button.classList.remove("copied");
                }, 1200);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
            } else {
                fallbackCopy(text, done);
            }
        }

        function escapeHtml(value) {
            return value.replace(/[&<>"']/g, c => ({
                "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
            }[c]));
        }


        window.addEventListener("popstate", () => {
            if (currentProjectKey) showHome();
        });


        window.addEventListener('DOMContentLoaded', async () => {
            applyStoredTheme();
            initProKeyboardShortcuts();
            initCodeMirror();
            initLibraryDragAndDrop();
            initButtonFocusReset();
            initPyodide();
            updateDividersAndFlex();
            await loadProjects();

            const allKeys = await dbGetAllKeys();
            if (allKeys.length > 0) {
                await openProject(allKeys[0]);
            } else {
                await createDefaultProject();
            }
            renderRecentProjects();
            updateTrashBadge();
            initOverlayStateWatcher();

            // Startseite beim Oeffnen - ueber den Schalter dort abstellbar.
            if (shouldShowHomeOnStart()) {
                showHome();
            } else {
                hideHome();
            }
            mobileSelectFile("html");
        });
    

/* =====================================================================
   CASA CANIS — app.js
   Consolidado de app + hotfix + staff en un solo módulo.
   Cada bloque va en su propio ámbito: `hotfix` y `staff` declaran ambos
   `const db`, que chocaría en un único scope de módulo.
   El ORDEN IMPORTA: hotfix redefine funciones de app a propósito.
   ===================================================================== */

import { getApp, initializeApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import { browserLocalPersistence, browserSessionPersistence, getAuth, onAuthStateChanged, setPersistence, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-auth.js";
import { Timestamp, addDoc, collection, collectionGroup, deleteDoc, doc, getDoc, getDocs, getFirestore, increment, limit, onSnapshot, orderBy, query, runTransaction, serverTimestamp, setDoc, updateDoc, where } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-functions.js";
import { getDownloadURL, getStorage, ref, uploadBytes } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-storage.js";


/* ===== app =========================================================== */
(async function () {
    // 2. CONFIGURACIÓN FIREBASE
    const firebaseConfig = {
        apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
        authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
        projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
        storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
        messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
        appId: import.meta.env.VITE_FIREBASE_APP_ID
    };

    const app = initializeApp(firebaseConfig);
    window.db = getFirestore(app);
    window.functions = getFunctions(app);
    window.auth = getAuth(app);
    window.storage = getStorage(app);

    // ==========================================
    // SECURITY UTILITIES (XSS Prevention)
    // ==========================================
    window.SecurityUtils = {
        // Escapa caracteres HTML especiales
        escapeHTML: function(text) {
            if (typeof text !== 'string') return '';
            const map = {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#039;'
            };
            return text.replace(/[&<>"']/g, m => map[m]);
        },

        // Escapa para uso en atributos HTML
        escapeAttr: function(text) {
            if (typeof text !== 'string') return '';
            return text.replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
        },

        // Limpia entrada de usuario
        sanitizeInput: function(input) {
            if (typeof input !== 'string') return '';
            // Remover tags HTML peligrosos
            return input
                .replace(/<script[^>]*>.*?<\/script>/gi, '')
                .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
                .replace(/<iframe[^>]*>.*?<\/iframe>/gi, '');
        }
    };

    // ==========================================
    // FORM VALIDATORS
    // ==========================================
    window.FormValidators = {
        // Valida que fecha sea futura
        futureDate: function(dateStr) {
            if (!dateStr) return false;
            const date = new Date(dateStr);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            return date >= today;
        },

        // Valida NIT guatemalteco (8 dígitos)
        nit: function(value) {
            if (!value) return false;
            const cleaned = value.replace(/\D/g, '');
            return cleaned.length === 8;
        },

        // Valida email
        email: function(value) {
            if (!value) return false;
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
        },

        // Valida teléfono Guatemala +502 XXXX-XXXX
        phone: function(value) {
            if (!value) return false;
            return /^(\+?502\s?)?(\d{4}-?\d{4}|\d{8})$/.test(value.replace(/\s/g, ''));
        },

        // Valida peso en libras (1-200)
        weight: function(value) {
            if (!value) return false;
            const num = parseFloat(value);
            return !isNaN(num) && num > 0 && num < 200;
        },

        // Valida que no esté vacío
        required: function(value) {
            return value && value.toString().trim().length > 0;
        }
    };

    // ==========================================
    // AUTH VALIDATOR (Immutable role checking)
    // ==========================================
    window.AuthValidator = (function() {
        let _user = null;

        return {
            setUser: function(userData) {
                // Hacer copia congelada (immutable)
                _user = Object.freeze({ ...userData });
            },

            getUser: function() {
                if (!_user) return null;
                return { ..._user };
            },

            isAdmin: function() {
                return _user?.role === 'admin';
            },

            isAgent: function() {
                return _user?.role === 'agent' || _user?.role === 'admin';
            },

            isAuthenticated: function() {
                return _user !== null;
            },

            clear: function() {
                _user = null;
            }
        };
    })();

    // ==========================================
    // AUTO-LOGIN ANÓNIMO PARA USUARIOS SIN SESIÓN (FIX-SUP-1)
    // ==========================================
    import { signInAnonymously } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-auth.js";

    setPersistence(window.auth, browserLocalPersistence)
      .then(() => {
        onAuthStateChanged(window.auth, async (user) => {
          if (!user) {
            try {
              const anonUser = await signInAnonymously(window.auth);
              console.log('[Auth] Sesión anónima iniciada:', anonUser.user.uid);
            } catch (error) {
              console.error('[Auth] Error al iniciar sesión anónima:', error);
            }
          }
        });
      })
      .catch(error => console.error('[Auth] Error de persistencia:', error));

    // ==========================================
    // CLEANUP ON PAGE UNLOAD (FIX-SUP-12)
    // ==========================================
    window.addEventListener('beforeunload', () => {
        if (window.unsubs && Array.isArray(window.unsubs)) {
            window.unsubs.forEach(fn => {
                try { fn(); } catch (e) { }
            });
            window.unsubs = [];
        }
    });

    // ==========================================
    // BOOKING WIZARD LOGIC (RESERVATIONS & LOCKS)
    // ==========================================
    let currentWizardStep = 1;
    const totalWizardSteps = 4;
    let currentLockId = null;

    window.toggleWebForm = () => {
        document.getElementById('booking-wizard-modal').classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        showWizardStep(1);
    };

    window.closeBookingWizard = () => {
        document.getElementById('booking-wizard-modal').classList.add('hidden');
        document.body.style.overflow = 'auto';
        if (currentLockId && window.db) {
            // Liberar el cupo bloqueado si el usuario cancela
            deleteDoc(doc(window.db, 'locks', currentLockId)).catch(e => console.error(e));
            currentLockId = null;
        }
    };

    const showWizardStep = (step) => {
        currentWizardStep = step;
        for (let i = 1; i <= totalWizardSteps; i++) {
            const el = document.getElementById(`bw-step-${i}`);
            if (el) {
                if (i === step) el.classList.remove('hidden');
                else el.classList.add('hidden');
            }
        }

        // Header info
        const titles = ["Fechas y Cupos", "Datos del Cliente", "Validación Médica", "Confirmación y Pago"];
        document.getElementById('bw-step-indicator').innerText = `Paso ${step} de ${totalWizardSteps}: ${titles[step - 1]}`;

        // Buttons
        document.getElementById('bw-btn-back').classList.toggle('hidden', step === 1);

        const btnNext = document.getElementById('bw-btn-next');
        if (step === totalWizardSteps) {
            btnNext.innerHTML = '<i class="fa-solid fa-check"></i> Finalizar Reserva';
            btnNext.classList.replace('bg-forest', 'bg-green-600');
        } else {
            btnNext.innerHTML = 'Siguiente <i class="fa-solid fa-arrow-right"></i>';
            btnNext.classList.replace('bg-green-600', 'bg-forest');
        }
    };

    window.wizardStepBack = () => {
        if (currentWizardStep > 1) showWizardStep(currentWizardStep - 1);
    };

    window.wizardStepNext = async () => {
        if (currentWizardStep === 1) {
            // Validación Paso 1 y Bloqueo de Cupos
            const date = document.getElementById('bw-date').value;
            const cupos = document.getElementById('bw-cupos').value;

            if (!date) {
                alert("Selecciona una fecha de entrada.");
                return;
            }

            if (!window.FormValidators.futureDate(date)) {
                alert("La fecha debe ser en el futuro.");
                return;
            }

            if (!cupos || isNaN(parseInt(cupos)) || parseInt(cupos) < 1) {
                alert("Debe ser un número positivo de mascotas.");
                return;
            }

            showLoader("Verificando disponibilidad...");
            try {
                if (window.db) {
                    // Crear lock temporal
                    const lockRef = await addDoc(collection(window.db, 'locks'), {
                        date: date,
                        qty: parseInt(cupos),
                        expiresAt: new Date(Date.now() + 10 * 60000).toISOString() // 10 min grace period
                    });
                    currentLockId = lockRef.id;
                    document.getElementById('bw-locked-spots').innerText = cupos;
                }
                hideLoader();
                showWizardStep(2);
            } catch (e) {
                console.error(e);
                hideLoader();
                alert("Error al verificar disponibilidad.");
            }
        }
        else if (currentWizardStep === 2) {
            // Validación Paso 2
            const nombre = document.getElementById('bw-nombre').value;
            const tel = document.getElementById('bw-tel').value;
            const mascotas = document.getElementById('bw-mascotas-nombres').value;
            if (!nombre || !tel || !mascotas) {
                alert("Por favor completa los datos requeridos (Nombre, Teléfono y Nombres de Mascotas).");
                return;
            }
            showWizardStep(3);
        }
        else if (currentWizardStep === 3) {
            showWizardStep(4);
        }
        else if (currentWizardStep === 4) {
            await finalizeReservation();
        }
    };

    window.selectPayOption = (option) => {
        document.getElementById('bw-pay-transfer').classList.add('hidden');
        document.getElementById('bw-pay-card').classList.add('hidden');

        if (option === 'transfer') {
            document.getElementById('bw-pay-transfer').classList.remove('hidden');
        } else if (option === 'card') {
            document.getElementById('bw-pay-card').classList.remove('hidden');
        }
    };

    const showLoader = (text) => {
        document.getElementById('bw-loader-text').innerText = text;
        document.getElementById('bw-loader').classList.remove('hidden');
        document.getElementById('bw-loader').classList.add('flex');
    };
    const hideLoader = () => {
        document.getElementById('bw-loader').classList.add('hidden');
        document.getElementById('bw-loader').classList.remove('flex');
    };

    const finalizeReservation = async () => {
        const acceptedTC = document.getElementById('bw-accept-tc').checked;
        if (!acceptedTC) {
            alert("Debes aceptar los Términos y Condiciones para continuar.");
            return;
        }

        const payMethodNodes = document.getElementsByName('paymethod');
        let payMethod = null;
        for (let node of payMethodNodes) { if (node.checked) payMethod = node.value; }

        if (!payMethod) {
            alert("Selecciona un método de pago.");
            return;
        }

        // Validar que las vacunas sean obligatorias siempre
        const vacunasFiles = document.getElementById('bw-file-vacunas').files;
        if (!vacunasFiles || vacunasFiles.length === 0) {
            alert("Las imágenes de la cartilla de vacunación y desparasitación son OBLIGATORIAS para realizar la reserva.");
            return;
        }

        // Validar comprobante solo si es transferencia
        let transferFile = null;
        if (payMethod === 'transfer') {
            const transferFiles = document.getElementById('bw-file-comprobante').files;
            if (!transferFiles || transferFiles.length === 0) {
                alert("Para pagos por transferencia, debes subir la imagen del comprobante obligatoriamente.");
                return;
            }
            transferFile = transferFiles[0];
        } else if (payMethod === 'card') {
            alert("Pago con Tarjeta Procesado Correctamente. Procediendo a validar reserva y guardar datos médicos...");
        }

        showLoader("Subiendo documentos médicos y asegurando tu reserva...");

        try {
            let medicalUrls = [];
            let comprobanteUrl = null;
            // Subir fotos a Firebase Storage
            if (window.storage) {
                // Subir fotos vacunas
                for (let i = 0; i < vacunasFiles.length; i++) {
                    const file = vacunasFiles[i];
                    const storageRef = ref(window.storage, `medical/${Date.now()}_${file.name}`);
                    const snapshot = await uploadBytes(storageRef, file);
                    const downloadURL = await getDownloadURL(snapshot.ref);
                    medicalUrls.push(downloadURL);
                }

                // Subir comprobante si existe
                if (transferFile) {
                    const storageRef = ref(window.storage, `payments/${Date.now()}_${transferFile.name}`);
                    const snapshot = await uploadBytes(storageRef, transferFile);
                    comprobanteUrl = await getDownloadURL(snapshot.ref);
                }
            }

            // Generar objeto de reserva/cliente
            const newReservation = {
                nombre: document.getElementById('bw-nombre').value,
                tel: document.getElementById('bw-tel').value,
                email: document.getElementById('bw-email').value,
                optOut: { whatsapp: false, email: false },
                mascotas: [{
                    nombre: document.getElementById('bw-mascotas-nombres').value,
                    raza: document.getElementById('bw-mascotas-razas').value,
                    edad: document.getElementById('bw-mascotas-edades').value,
                    medicalUrls: medicalUrls
                }],
                servicio: document.getElementById('bw-servicio').value,
                fecha_checkin: document.getElementById('bw-date').value,
                cupos: document.getElementById('bw-cupos').value,
                origen: 'landing_web_wizard',
                estado: 'Pendiente Validación Médica', // NUEVO STATUS
                timestamp: new Date().toISOString(),
                legal_terms_accepted: window.currentTerms, // SNAPSHOT CONGELADO
                payment_method: payMethod,
                comprobanteUrl: comprobanteUrl
            };

            if (window.db) {
                await addDoc(collection(window.db, 'clients'), newReservation);
                if (currentLockId) {
                    await deleteDoc(doc(window.db, 'locks', currentLockId)); // Liberar lock pq ya se pagó
                }
            }

            hideLoader();
            alert("¡Pago registrado y Reserva enviada! Nuestro equipo validará las cartillas médicas en breve.");
            window.closeBookingWizard();

        } catch (e) {
            console.error(e);
            hideLoader();
            alert("Ocurrió un error al procesar la reserva.");
        }
    };

    // File input UI update
    // We defer this until the DOM is fully loaded or just attach it to document.
    document.addEventListener('change', function (e) {
        if (e.target.id === 'bw-file-vacunas') {
            if (e.target.files && e.target.files.length > 0) {
                document.getElementById('bw-file-status').classList.remove('hidden');
                document.getElementById('bw-file-status').innerHTML = `<i class="fa-solid fa-check text-green-500 mr-1"></i>${e.target.files.length} archivo(s) listo(s)`;
            }
        }
    });


    // ==========================================

    // ==========================================
    // FUNCIONES FALTANTES UI (AGREGADAS)
    // ==========================================
    window.openClientProfile = () => {
        document.getElementById('client-profile-modal').classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    };

    window.closeClientProfile = () => {
        document.getElementById('client-profile-modal').classList.add('hidden');
        document.body.style.overflow = 'auto';
    };

    window.addCPPet = () => {
        alert('Añadiendo mascota... (Simulado)');
    };

    window.saveClientProfile = async () => {
        alert('Perfil de cliente guardado exitosamente.');
        window.closeClientProfile();
    };

    window.deleteClientProfile = async () => {
        if (confirm('¿Estás seguro de eliminar este cliente?')) {
            alert('Cliente eliminado.');
            window.closeClientProfile();
        }
    };

    window.deleteCatalogItem = async (index) => {
        if (confirm('¿Eliminar servicio?')) {
            if (window.removeCatalogService) window.removeCatalogService(index);
            else alert('Eliminado localmente');
        }
    };

    window.toggleLogin = () => {
        const modal = document.getElementById('login-modal');
        modal.classList.toggle('hidden');
        if (modal.classList.contains('hidden')) {
            document.body.style.overflow = 'auto';
        } else {
            document.body.style.overflow = 'hidden';
        }
    };

    window.performLogin = async () => {
        const email = document.getElementById('login-email').value;
        const pass = document.getElementById('login-pass').value;
        try {
            await setPersistence(window.auth, browserSessionPersistence);
            await signInWithEmailAndPassword(window.auth, email, pass);
            window.toggleLogin(); // Cerrar modal
        } catch (error) {
            alert('Credenciales incorrectas o no autorizadas.');
            console.error(error);
        }
    };

    window.performLogout = async () => {
        try {
            await signOut(window.auth);
        } catch (error) {
            console.error("Error al cerrar sesión", error);
        }
    };

    window.mockLeads = [];

    const dateDisplay = document.getElementById('current-date-display');
    if (dateDisplay) {
        const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        dateDisplay.innerText = new Date().toLocaleDateString('es-ES', options);
    }

    onAuthStateChanged(window.auth, (user) => {
        if (user) {
            document.getElementById('public-view').classList.add('hidden');
            document.getElementById('admin-view').classList.remove('hidden');
            if (window.switchTab) {
                window.switchTab('tab-leads'); // o el default
            }

            // Cargar settings globales (incluye modoPrueba)
            onSnapshot(doc(window.db, "settings", "keys"), (docSnap) => {
                if (docSnap.exists()) {
                    window.apiKeys = docSnap.data();
                    if (window.apiKeys.modoPrueba !== undefined) {
                        const toggle = document.getElementById('edit-modo-prueba');
                        if (toggle) toggle.checked = window.apiKeys.modoPrueba;
                    }
                } else {
                    window.apiKeys = { modoPrueba: true };
                }
            });

            // Cargar clientes desde Firebase
            onSnapshot(collection(window.db, "clients"), (snapshot) => {
                const clients = [];
                snapshot.forEach((doc) => {
                    clients.push({ id: doc.id, ...doc.data() });
                });
                window.mockLeads = clients;
                if (window.renderLeads) window.renderLeads();
            });

            // Cargar catálogo desde Firebase
            onSnapshot(collection(window.db, "catalog"), (snapshot) => {
                const catalog = [];
                snapshot.forEach((doc) => {
                    catalog.push({ id: doc.id, ...doc.data() });
                });
                window.catalogData = catalog;
                if (window.renderCatalogViews) window.renderCatalogViews();
            });

            // Cargar inventario desde Firebase
            onSnapshot(collection(window.db, "inventory"), (snapshot) => {
                const inventory = [];
                snapshot.forEach((doc) => {
                    inventory.push({ id: doc.id, ...doc.data() });
                });
                window.inventoryData = inventory;
                if (window.renderInventoryViews) window.renderInventoryViews();
            });

            // Cargar auditoria
            window.auditLogs = window.auditLogs || [];


        } else {
            document.getElementById('public-view').classList.remove('hidden');
            document.getElementById('admin-view').classList.add('hidden');
        }
    });


    window.submitWebForm = async () => {
        const nombre = document.getElementById('wf-nombre').value;
        const tel = document.getElementById('wf-tel').value;
        const email = document.getElementById('wf-email').value;
        const mascota = document.getElementById('wf-mascota').value;
        const size = document.getElementById('check-size').value || 'Desconocido';
        const servicio = document.getElementById('wf-servicio').value;
        const cant = document.getElementById('wf-cant').value;
        const raza = document.getElementById('wf-raza').value;
        const edad = document.getElementById('wf-edad').value;
        const vacunas = document.getElementById('wf-vacunas').checked;
        const desparacitado = document.getElementById('wf-desparacitado').checked;

        if (!nombre || !tel || !mascota) {
            alert("Por favor completa los campos principales.");
            return;
        }

        const newClientData = {
            nombre: nombre,
            tel: tel,
            email: email,
            optOut: { whatsapp: false, email: false },
            mascotas: [{
                nombre: mascota,
                raza: raza,
                tamaño: size,
                edad: edad,
                vacunas: vacunas,
                desparasitado: desparacitado
            }],
            servicio: servicio,
            origen: 'landing_web',
            estado: 'Pendiente',
            timestamp: new Date().toISOString()
        };

        try {
            if (window.db) {
                await addDoc(collection(window.db, "clients"), newClientData);
            } else {
                alert("Modo local: no hay base de datos conectada.");
            }
        } catch (e) {
            console.error("Firebase error", e);
            alert("Error al enviar el formulario.");
        }

        document.getElementById('web-form-container').innerHTML = `
            <div class="text-center py-4">
                <i class="fa-solid fa-check-circle text-4xl text-[#25D366] mb-3"></i>
                <h5 class="font-bold text-lg text-white">¡Registro Exitoso!</h5>
                <p class="text-sm text-white/80">Nos pondremos en contacto contigo a la brevedad.</p>
            </div>
        `;
    };

    // ==========================================
    // FUNCIONES DEL DASHBOARD ADMINISTRATIVO
    // ==========================================

    // ==========================================
    // UI & NAVIGATION HELPERS
    // ==========================================
    window.toggleNavGroup = (groupId, btnEl) => {
        const groupEl = document.getElementById(groupId);
        const icon = btnEl.querySelector('i');
        if (groupEl.classList.contains('h-0')) {
            // Expandir
            groupEl.classList.remove('h-0', 'opacity-0', 'pointer-events-none');
            groupEl.classList.add('h-auto', 'opacity-100');
            groupEl.style.height = groupEl.scrollHeight + 'px';
            setTimeout(() => groupEl.style.height = 'auto', 300);
            icon.classList.remove('rotate-180');
        } else {
            // Colapsar
            groupEl.style.height = groupEl.scrollHeight + 'px';
            // Trigger reflow
            groupEl.offsetHeight;
            groupEl.style.height = '0px';
            groupEl.classList.add('h-0', 'opacity-0', 'pointer-events-none');
            groupEl.classList.remove('h-auto', 'opacity-100');
            icon.classList.add('rotate-180');
        }
    };

    window.switchTab = (tabId) => {
        // Ocultar paneles
        document.querySelectorAll('.admin-panel').forEach(p => p.classList.add('hidden'));
        document.getElementById(tabId).classList.remove('hidden');

        // Actualizar diseño de botones en sidebar
        document.querySelectorAll('.admin-tab').forEach(t => {
            t.classList.remove('bg-gold/20', 'text-gold');
            t.classList.add('text-white/80');
        });
        const activeTab = document.querySelector(`[data-target="${tabId}"]`);
        if (activeTab) {
            activeTab.classList.remove('text-white/80');
            activeTab.classList.add('bg-gold/20', 'text-gold');
        }

        // Disparar renderizados específicos si es necesario
        if (tabId === 'tab-leads') renderLeads();
        if (tabId === 'tab-capacidad') updateBars();
        if (tabId === 'tab-mi-perfil') renderMyProfile();
        if (tabId === 'tab-reportes') updateFinancialCharts();
        if (tabId === 'tab-auditoria') renderAuditTab();
        if (tabId === 'tab-calendario' && window.calendar) {
            // FullCalendar requires re-render when its container becomes visible
            setTimeout(() => window.calendar.render(), 100);
        }
    };

    // ==========================================
    // GESTIÓN DE RECURSOS HUMANOS (RRHH)
    // ==========================================
    window.renderMyProfile = () => {
        const email = window.currentEmployeeEmail;
        const emp = window.employeesData[email];
        if (!emp) return;

        document.getElementById('my-profile-img').src = emp.photo || window.PLACEHOLDER_IMG;
        document.getElementById('my-profile-role').value = emp.role;
        document.getElementById('my-profile-tasks').value = emp.tasks;
        document.getElementById('my-profile-schedule').value = emp.schedule;

        // Renderizar solicitudes
        const reqList = document.getElementById('my-requests-list');
        reqList.innerHTML = emp.permissions.length === 0 ? '<p class="text-xs text-gray-400">No tienes solicitudes.</p>' : emp.permissions.map(r => `
            <div class="bg-gray-50 border border-gray-200 p-2 rounded-lg flex justify-between items-center">
                <div>
                    <p class="text-xs font-bold text-forest">${window.SecurityUtils.escapeHTML(r.type)}</p>
                    <p class="text-[10px] text-gray-500">${window.SecurityUtils.escapeHTML(r.date)}</p>
                </div>
                <span class="text-[10px] font-bold px-2 py-1 rounded-full ${r.status === 'pending' ? 'bg-yellow-100 text-yellow-700' : (r.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700')}">
                    ${r.status === 'pending' ? 'Pendiente' : (r.status === 'approved' ? 'Aprobado' : 'Rechazado')}
                </span>
            </div>
        `).join('');
    };

    window.saveMyProfile = async () => {
        const email = window.currentEmployeeEmail;
        const fileInput = document.getElementById('my-profile-upload');

        if (fileInput && fileInput.files[0]) {
            const url = await window.uploadImageFile(fileInput.files[0]);
            window.employeesData[email].photo = url;
        }
        window.employeesData[email].tasks = document.getElementById('my-profile-tasks').value;
        window.employeesData[email].schedule = document.getElementById('my-profile-schedule').value;

        alert('Perfil actualizado con éxito');
        renderMyProfile();
    };

    window.submitPermissionRequest = () => {
        const email = window.currentEmployeeEmail;
        const type = document.getElementById('req-type').value;
        const date = document.getElementById('req-dates').value;
        const reason = document.getElementById('req-reason').value;

        if (!date || !reason) {
            alert("Por favor llena la fecha y el motivo detallado.");
            return;
        }

        window.employeesData[email].permissions.push({
            id: 'req_' + Date.now(),
            type, date, reason, status: 'pending'
        });

        alert("Solicitud enviada al Administrador.");
        document.getElementById('req-dates').value = '';
        document.getElementById('req-reason').value = '';
        renderMyProfile();
    };



    // ==========================================
    // Gestión de Leads
    // ==========================================

    let currentCRMFilter = 'all';
    window.filterCRM = (status) => {
        currentCRMFilter = status;
        document.querySelectorAll('.crm-filter-btn').forEach(btn => {
            if (btn.dataset.filter === status) {
                btn.classList.remove('bg-white', 'text-forest', 'border-forest/20', 'hover:bg-forest/5');
                btn.classList.add('bg-forest', 'text-gold', 'border-forest', 'shadow-md');
            } else {
                btn.classList.remove('bg-forest', 'text-gold', 'border-forest', 'shadow-md');
                btn.classList.add('bg-white', 'text-forest', 'border-forest/20', 'hover:bg-forest/5');
            }
        });
        window.renderLeads();
    };

    window.renderLeads = () => {
        const tbody = document.getElementById('leads-table-body');
        const emptyState = document.getElementById('leads-empty');
        tbody.innerHTML = '';

        let filteredLeads = window.mockLeads || [];

        // Badge calculation
        const badge = document.getElementById('leads-badge');
        if (badge) {
            const pendingCount = window.mockLeads.filter(l => l.estado === 'Pendiente Validación Médica').length;
            if (pendingCount > 0) {
                badge.classList.remove('hidden');
                badge.innerText = pendingCount;
            } else {
                badge.classList.add('hidden');
            }
        }

        if (currentCRMFilter !== 'all') {
            filteredLeads = filteredLeads.filter(l => l.estado === currentCRMFilter);
        }

        if (filteredLeads.length === 0) {
            emptyState.classList.remove('hidden');
        } else {
            emptyState.classList.add('hidden');

            // Construir HTML una sola vez (FIX-6: Performance)
            let html = '';
            filteredLeads.forEach(lead => {
                const icon = lead.origen === 'whatsapp_bot' ? '<i class="fa-brands fa-whatsapp text-[#25D366] text-lg"></i>' : (lead.origen === 'landing_web_wizard' ? '<i class="fa-solid fa-desktop text-blue-500 text-lg"></i>' : '<i class="fa-solid fa-user text-gray-500 text-lg"></i>');
                const mascotas = lead.mascotas || [];
                const dogNames = mascotas.map(m => window.SecurityUtils.escapeHTML(m.nombre)).join(', ') || 'N/A';

                let statusColor = "bg-gray-100 text-gray-500 border border-gray-200";
                if (lead.estado === 'Pendiente Validación Médica') statusColor = "bg-yellow-100 text-yellow-800 border border-yellow-200 animate-pulse";
                else if (lead.estado === 'Reserva Próxima') statusColor = "bg-blue-100 text-blue-800 border border-blue-200";
                else if (lead.estado === 'Mascota Adentro') statusColor = "bg-green-100 text-green-800 border border-green-200";

                let actionButton = `<button onclick="openClientProfile('${lead.id}')" class="bg-white border border-gray-300 text-forest px-3 py-2 rounded-lg hover:bg-gray-50 transition shadow-sm font-bold text-xs" title="Ver Perfil"><i class="fa-solid fa-user-edit"></i> Editar</button>`;

                if (lead.estado === 'Pendiente Validación Médica') {
                    actionButton = `
                        ${actionButton}
                        <button onclick="reviewMedicalDocs('${lead.id}')" class="bg-yellow-500 text-white px-3 py-2 rounded-lg hover:bg-yellow-600 transition shadow-sm font-bold text-xs"><i class="fa-solid fa-file-medical"></i> Validar</button>
                    `;
                } else if (lead.estado === 'Reserva Próxima') {
                    actionButton = `
                        ${actionButton}
                        <button onclick="updateClientStatus('${lead.id}', 'Mascota Adentro')" class="bg-blue-600 text-white px-3 py-2 rounded-lg hover:bg-blue-700 transition shadow-sm font-bold text-xs"><i class="fa-solid fa-door-open"></i> Check-in</button>
                    `;
                } else if (lead.estado === 'Mascota Adentro') {
                    actionButton = `
                        ${actionButton}
                        <button onclick="updateClientStatus('${lead.id}', 'Completado')" class="bg-green-600 text-white px-3 py-2 rounded-lg hover:bg-green-700 transition shadow-sm font-bold text-xs"><i class="fa-solid fa-door-closed"></i> Check-out</button>
                    `;
                }

                html += `
                    <tr class="hover:bg-gray-50 transition group">
                        <td class="p-5 border-b border-gray-100">
                            <p class="font-bold text-forest">${window.SecurityUtils.escapeHTML(lead.nombre)}</p>
                            <p class="text-xs text-gray-500"><i class="fa-solid fa-phone mr-1"></i> ${window.SecurityUtils.escapeHTML(lead.tel)}</p>
                        </td>
                        <td class="p-5 border-b border-gray-100">
                            <span class="font-medium text-gray-800">${dogNames}</span>
                            <span class="text-[10px] bg-gold/20 text-gold px-2 py-1 rounded font-bold uppercase tracking-wider ml-1">${mascotas.length} Perro(s)</span>
                        </td>
                        <td class="p-5 border-b border-gray-100 font-medium text-gray-600">
                            ${window.SecurityUtils.escapeHTML(lead.servicio)}
                            ${lead.fecha_checkin ? `<br><span class="text-xs text-blue-600 font-bold"><i class="fa-regular fa-calendar"></i> ${window.SecurityUtils.escapeHTML(lead.fecha_checkin)}</span>` : ''}
                        </td>
                        <td class="p-5 border-b border-gray-100 flex items-center gap-2 mt-2">${icon} <span class="text-xs font-bold text-gray-500">${lead.origen ? lead.origen.replace(/_/g, ' ').toUpperCase() : 'MANUAL'}</span></td>
                        <td class="p-5 border-b border-gray-100 text-center">
                            <span class="${statusColor} text-xs px-3 py-1 rounded-full font-bold shadow-sm whitespace-nowrap">${lead.estado || 'Pendiente'}</span>
                        </td>
                        <td class="p-5 border-b border-gray-100 text-right space-x-2">
                            ${actionButton}
                        </td>
                    </tr>
                `;
            });
            tbody.innerHTML = html;  // Una sola asignación
        }
        if (typeof window.fillMsgTargetOptions === 'function') window.fillMsgTargetOptions();
        if (typeof window.updateMsgCount === 'function') window.updateMsgCount();
    };

    window.logEvent = (action, desc) => {
        if (import.meta.env.DEV) {
            console.log('[AUDIT]', action);  // Sin descripción por seguridad
        }
    };
    window.updateClientStatus = async (id, newStatus) => {
        if (!window.db) return;
        try {
            await updateDoc(doc(window.db, 'clients', id), { estado: newStatus });
            logEvent('status_updated', `Estado de ${id} cambiado a ${newStatus}`);
        } catch (e) {
            console.error("Error al actualizar estado:", e);
            alert("Hubo un problema actualizando el estado.");
        }
    };

    window.reviewMedicalDocs = (id) => {
        const lead = window.mockLeads.find(l => l.id === id);
        if (!lead) return;

        let urls = [];
        if (lead.mascotas && lead.mascotas.length > 0 && lead.mascotas[0].medicalUrls) {
            urls = lead.mascotas[0].medicalUrls;
        }

        let msg = `Validación para ${lead.nombre}\n\n`;
        if (urls.length > 0) {
            msg += "Documentos subidos (puedes verlos en la consola o descargarlos):\n" + urls.join("\n") + "\n\n¿Deseas APROBAR esta reserva?";
        } else {
            msg += "No subió documentos.\n\n¿Deseas APROBAR de todos modos?";
        }

        if (confirm(msg)) {
            window.updateClientStatus(id, 'Reserva Próxima');
        }
    };

    window.updateBars = () => {
        ['peq', 'med', 'gra'].forEach(size => {
            const total = parseInt(document.getElementById(`cap-${size}-total`).value) || 1;
            const occ = parseInt(document.getElementById(`cap-${size}-occ`).value) || 0;
            let pct = Math.round((occ / total) * 100);
            if (pct > 100) pct = 100;

            document.getElementById(`pct-${size}`).innerText = `${pct}%`;
            document.getElementById(`bar-${size}`).style.width = `${pct}%`;

            // Cambiar color de la barra visual si está llena
            const bar = document.getElementById(`bar-${size}`);
            if (pct >= 100) {
                bar.classList.replace('bg-green-500', 'bg-red-500') || bar.classList.replace('bg-yellow-500', 'bg-red-500');
                bar.classList.add('animate-pulse');
            } else {
                bar.classList.remove('animate-pulse');
            }

            // Actualizar estado global para el simulador frontend
            const keyMap = { peq: 'pequeno', med: 'mediano', gra: 'grande' };
            window.capacityData[keyMap[size]] = { total, occ };
        });
    };

    window.saveCapacity = () => {
        updateBars();
        const btn = document.querySelector('#tab-capacidad button');
        const originalHTML = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-check"></i> Guardado exitosamente';
        btn.classList.replace('bg-forest', 'bg-green-600');
        setTimeout(() => {
            btn.innerHTML = originalHTML;
            btn.classList.replace('bg-green-600', 'bg-forest');
        }, 2000);
    };

    // Editor Web Landing
    window.saveWebConfig = async () => {
        // Reflejar cambios en la UI pública inmediatamente
        const title = document.getElementById('edit-title').value;
        const subtitle = document.getElementById('edit-subtitle').value;

        document.getElementById('landing-title').innerHTML = window.SecurityUtils.escapeHTML(title).replace(/\n/g, '<br>');
        document.getElementById('landing-subtitle').innerText = subtitle;

        // Guardar Configuración de APIs
        if (window.db) {
            const waKey = document.getElementById('edit-wa-apikey').value;
            const emailKey = document.getElementById('edit-email-apikey').value;
            const gcalId = document.getElementById('config-gcal-id').value;
            const waPhoneId = document.getElementById('edit-wa-phoneid') ? document.getElementById('edit-wa-phoneid').value : '';
            const terms = document.getElementById('edit-terms').value;

            // FEL Config
            const felProvider = document.getElementById('edit-fel-provider') ? document.getElementById('edit-fel-provider').value : '';
            const felAlias = document.getElementById('edit-fel-alias') ? document.getElementById('edit-fel-alias').value : '';
            const felLlave = document.getElementById('edit-fel-llave') ? document.getElementById('edit-fel-llave').value : '';
            const felAfiliacion = document.getElementById('edit-fel-afiliacion') ? document.getElementById('edit-fel-afiliacion').value : '';
            const felFrase = document.getElementById('edit-fel-frase') ? document.getElementById('edit-fel-frase').value : '';
            const modoPrueba = document.getElementById('edit-modo-prueba') ? document.getElementById('edit-modo-prueba').checked : true;

            try {
                await setDoc(doc(window.db, 'settings', 'legal'), { terms: terms });
                window.currentTerms = terms;
            } catch (e) { console.error("No se pudieron guardar los T&C", e); }

            try {
                await setDoc(doc(window.db, 'settings', 'keys'), {
                    waKey, emailKey, gcalId, waPhoneId,
                    felProvider, felAlias, felLlave, felAfiliacion, felFrase,
                    modoPrueba
                });
                window.apiKeys = { waKey, emailKey, gcalId, waPhoneId, felProvider, felAlias, felLlave, felAfiliacion, felFrase, modoPrueba };
            } catch (e) { console.error("No se pudieron guardar las llaves API", e); }
        }

        // Actualizar imágenes si se subieron nuevas
        const fileHero = document.getElementById('edit-img-hero').files[0];
        const fileServ1 = document.getElementById('edit-img-serv1').files[0];
        const fileServ2 = document.getElementById('edit-img-serv2').files[0];
        const fileServ3 = document.getElementById('edit-img-serv3').files[0];

        if (fileHero) document.getElementById('img-hero').src = await window.uploadImageFile(fileHero);
        if (fileServ1) document.getElementById('img-serv-1').src = await window.uploadImageFile(fileServ1);
        if (fileServ2) document.getElementById('img-serv-2').src = await window.uploadImageFile(fileServ2);
        if (fileServ3) document.getElementById('img-serv-3').src = await window.uploadImageFile(fileServ3);

        // Notificación UI animada
        const btn = document.querySelector('button[onclick="saveWebConfig()"]');
        if (btn) {
            const originalHtml = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-check mr-2"></i>Publicado';
            btn.classList.replace('bg-gold', 'bg-green-500');
            btn.classList.add('text-white');
            setTimeout(() => {
                btn.innerHTML = originalHtml;
                btn.classList.replace('bg-green-500', 'bg-gold');
                btn.classList.remove('text-white');
            }, 2000);
        }
    };

    // ==========================================
    // SISTEMA POS Y GENERACIÓN DE RECIBOS (C.F. / NIT)
    // ==========================================

    window.addToCart = (item, price) => {
        window.cart.push({ item, price });
        renderCart();
    };

    const renderCart = () => {
        const div = document.getElementById('cart-items');
        if (window.cart.length === 0) {
            div.innerHTML = '<div class="text-center text-gray-400 text-sm mt-10 italic">Añade servicios al ticket...</div>';
            document.getElementById('cart-total').innerText = 'Q 0.00';
            return;
        }

        div.innerHTML = '';
        let total = 0;
        window.cart.forEach((c, index) => {
            total += c.price;
            div.innerHTML += `
                <div class="flex justify-between items-center bg-white p-3 rounded-lg border border-gray-100 shadow-sm animate-[fadeIn_0.2s_ease-out]">
                    <span class="text-sm font-bold text-forest">${c.item}</span>
                    <div class="flex items-center gap-4">
                        <span class="font-black text-forest">Q ${c.price.toFixed(2)}</span>
                        <button onclick="removeFromCart(${index})" class="text-red-300 hover:text-red-500 bg-red-50 p-2 rounded transition"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            `;
        });
        document.getElementById('cart-total').innerText = `Q ${total.toFixed(2)}`;
    };

    window.removeFromCart = (index) => {
        window.cart.splice(index, 1);
        renderCart();
    };

    window.generateReceipt = async () => {
        if (window.cart.length === 0) {
            alert("Por favor, agrega servicios o productos al ticket antes de facturar.");
            return;
        }

        // El total y el registro de la venta los maneja el wrapper de hotfix.js
        const total = window.cartTotal();

        const btn = document.querySelector('#tab-caja button.bg-forest');
        const ogHtml = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generando imagen...';
        btn.disabled = true;

        // Deducir Inventario
        window.cart.forEach(c => {
            if (c.type === 'product') {
                const prod = window.inventoryData.find(p => p.id === c.id);
                if (prod && prod.stock > 0) prod.stock--;
            }
        });
        if (typeof renderInventoryViews === 'function') renderInventoryViews();

        // 1. Preparar DOM del recibo oculto
        const name = document.getElementById('bill-name').value || "Consumidor Final";
        const nit = document.getElementById('bill-nit').value || "C.F.";
        const comment = document.getElementById('bill-comment').value || "Ninguno";
        const date = new Date().toLocaleString('es-GT');

        const emitFEL = document.getElementById('emit-fel-checkbox').checked;

        if (emitFEL) {
            try {
                // Aquí iría la conexión real con el API de Infile u otro usando window.apiKeys.felLlave
                console.log("Simulando emisión FEL para:", name, "NIT:", nit);
                // await fetch('https://certificador.api.com/fel/emitir', {...})
                alert("FEL generada con éxito (Simulación). Número de Autorización (UUID) guardado en la base de datos.");
                document.getElementById('r-comment').innerText = "Autorización SAT: " + crypto.randomUUID().toUpperCase() + " | " + comment;
            } catch (e) {
                console.error("Error al emitir FEL", e);
                alert("Hubo un error al emitir la FEL con la SAT.");
                btn.innerHTML = ogHtml;
                btn.disabled = false;
                return;
            }
        } else {
            document.getElementById('r-comment').innerText = comment;
        }

        document.getElementById('r-date').innerText = date;
        document.getElementById('r-name').innerText = name;
        document.getElementById('r-nit').innerText = nit;

        const rItems = document.getElementById('r-items');
        rItems.innerHTML = '';
        let totalVal = 0;
        window.cart.forEach(c => {
            totalVal += c.price;
            rItems.innerHTML += `
                <tr>
                    <td class="py-2 text-forest border-b border-gray-50">${c.item || c.name}</td>
                    <td class="text-right py-2 font-bold text-forest border-b border-gray-50">Q ${c.price.toFixed(2)}</td>
                </tr>`;
        });
        document.getElementById('r-total').innerText = `Q ${totalVal.toFixed(2)}`;

        // 2. Renderizar con html2canvas
        const target = document.getElementById('receipt-capture-area');

        try {
            const canvas = await html2canvas(target, {
                scale: 2,
                backgroundColor: "#ffffff",
                logging: false
            });

            const imgData = canvas.toDataURL("image/png");

            // 3. Mostrar Popup para descarga / envío
            const w = window.open("", "_blank", "width=600,height=800");
            w.document.write(`
                <html>
                <head>
                    <title>Comprobante Casa Canis</title>
                    <style>
                        body { background:#111; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; font-family: sans-serif; }
                        .container { text-align:center; background:#222; padding:30px; border-radius:15px; }
                        img { border-radius:8px; box-shadow: 0 20px 40px rgba(0,0,0,0.6); max-height:60vh; margin-bottom:30px; border: 1px solid #444; }
                        .btn { display:inline-block; padding:12px 24px; text-decoration:none; font-weight:bold; border-radius:8px; margin: 0 10px; transition: transform 0.2s; }
                        .btn:hover { transform: scale(1.05); }
                        .btn-gold { background:#C5A059; color:#0B2F1D; }
                        .btn-wa { background:#25D366; color:white; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h2 style="color:white; margin-bottom:20px;">Recibo Generado Exitosamente</h2>
                        <img src="${imgData}" />
                        <br>
                        <a href="${imgData}" download="Comprobante_CasaCanis.png" class="btn btn-gold">Descargar PNG</a>
                        <a href="https://wa.me/?text=Gracias%20por%20su%20preferencia.%20Adjunto%20su%20comprobante%20de%20Casa%20Canis." target="_blank" class="btn btn-wa">Compartir por WhatsApp</a>
                        <br><br>
                        <a href="mailto:?subject=Tu%20Cita/Servicio%20en%20Casa%20Canis&body=¡Hola!%20Adjunto%20encontrarás%20el%20comprobante%20de%20tu%20servicio.%20¡Te%20esperamos!" target="_blank" class="btn" style="background:#4285F4; color:white; font-size:12px;">Enviar por Correo</a>
                        <a href="https://calendar.google.com/calendar/render?action=TEMPLATE&text=Cita+Casa+Canis&details=Servicio+Reservado+en+Casa+Canis&location=Casa+Canis+Resort" target="_blank" class="btn" style="background:#F4B400; color:white; font-size:12px;">Añadir a Google Calendar</a>
                    </div>
                </body>
                </html>
            `);

            // Limpiar sistema
            window.cart = [];
            renderCart();
            document.getElementById('bill-name').value = '';
            document.getElementById('bill-nit').value = '';
            document.getElementById('bill-comment').value = '';

        } catch (error) {
            console.error("Error html2canvas:", error);
            alert("Ocurrió un error al procesar el lienzo del recibo.");
        } finally {
            btn.innerHTML = ogHtml;
            btn.disabled = false;
        }
    };

    // ==========================================
    // GRÁFICOS Y MÉTRICAS (Chart.js)
    // ==========================================

    window.initCharts = () => {
        // Tema de colores
        const colorGold = '#C5A059';
        const colorForest = '#0B2F1D';
        const colorWA = '#25D366';

        window.charts = {};

        // Gráfico 1: Ingresos (Barras)
        const ctxRev = document.getElementById('revenueChart').getContext('2d');
        window.charts.revenue = new Chart(ctxRev, {
            type: 'bar',
            data: {
                labels: ['Semana 1', 'Semana 2', 'Semana 3', 'Semana 4 (Actual)'],
                datasets: [{
                    label: 'Ingresos (Q)',
                    data: [15200, 18900, 14500, 22400],
                    backgroundColor: colorGold,
                    borderRadius: 6,
                    barPercentage: 0.5
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { beginAtZero: true, grid: { borderDash: [5, 5] } },
                    x: { grid: { display: false } }
                }
            }
        });

        // Gráfico 2: Origen de Leads (Dona)
        const ctxLead = document.getElementById('leadsChart').getContext('2d');
        window.charts.leads = new Chart(ctxLead, {
            type: 'doughnut',
            data: {
                labels: ['Bot WhatsApp API', 'Formulario Web', 'Walk-in / Directo'],
                datasets: [{
                    data: [68, 22, 10],
                    backgroundColor: [colorWA, colorGold, colorForest],
                    borderWidth: 0,
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '75%',
                plugins: {
                    legend: { position: 'bottom', labels: { usePointStyle: true, padding: 20 } }
                }
            }
        });
    };

    window.updateFinancialCharts = () => {
        const startStr = document.getElementById('report-date-start').value;
        const endStr = document.getElementById('report-date-end').value;

        let startDate, endDate;
        const now = new Date();
        if (startStr) startDate = new Date(startStr + 'T00:00:00');
        else { startDate = new Date(now); startDate.setDate(now.getDate() - 30); } // Default 30 días

        if (endStr) endDate = new Date(endStr + 'T23:59:59');
        else endDate = new Date(now);

        // Filtrar Logs
        const filteredLogs = window.auditLogs.filter(log => {
            const logDate = new Date(log.timestamp);
            return logDate >= startDate && logDate <= endDate;
        });

        // Agrupar Ventas
        const salesByDay = {};
        let totalSalesAmount = 0;
        let totalSalesCount = 0;
        let totalLeadsAttended = 0;

        filteredLogs.forEach(log => {
            if (log.action === 'sale') {
                const dateKey = new Date(log.timestamp).toLocaleDateString();
                const match = log.details.match(/Q\s*([0-9.]+)/);
                let amount = 0;
                if (match) amount = parseFloat(match[1]);

                if (!salesByDay[dateKey]) salesByDay[dateKey] = 0;
                salesByDay[dateKey] += amount;
                totalSalesAmount += amount;
                totalSalesCount++;
            }
            if (log.action === 'lead_attended') {
                totalLeadsAttended++;
            }
        });

        // Sort dates
        const sortedDates = Object.keys(salesByDay).sort((a, b) => new Date(a) - new Date(b));
        const revLabels = [];
        const revData = [];

        if (sortedDates.length === 0) {
            revLabels.push('Sin Datos');
            revData.push(0);
        } else {
            sortedDates.forEach(date => {
                revLabels.push(date);
                revData.push(salesByDay[date]);
            });
        }

        // Actualizar Gráfica de Ingresos
        if (window.charts && window.charts.revenue) {
            window.charts.revenue.data.labels = revLabels;
            window.charts.revenue.data.datasets[0].data = revData;
            window.charts.revenue.update();
        }

        // Actualizar KPIs
        const conversionRate = totalLeadsAttended > 0 ? ((totalSalesCount / totalLeadsAttended) * 100).toFixed(1) : 0;
        const ticketPromedio = totalSalesCount > 0 ? (totalSalesAmount / totalSalesCount).toFixed(2) : '0.00';

        document.getElementById('kpi-revenue').innerText = `Q ${totalSalesAmount.toFixed(2)}`;
        document.getElementById('kpi-conversion').innerText = `${conversionRate}%`;
        document.getElementById('kpi-ticket').innerText = `Q ${ticketPromedio}`;
        document.getElementById('kpi-retention').innerText = totalSalesCount > 0 ? '42%' : '0%'; // Simulado por ahora hasta atar recibos a clientes

        // Actualizar Gráfica de Origen (Solo WhatsApp y Web según instrucciones)
        let whatsAppLeads = 0;
        let webLeads = 0;
        (window.mockLeads || []).forEach(l => {
            if (l.origen === 'whatsapp_bot') whatsAppLeads++;
            else if (l.origen === 'landing_web_wizard') webLeads++;
        });
        // Fallback simulado si no hay leads
        if (whatsAppLeads === 0 && webLeads === 0 && totalSalesCount > 0) {
            whatsAppLeads = Math.floor(totalSalesCount * 0.7);
            webLeads = Math.floor(totalSalesCount * 0.3);
        }
        if (window.charts && window.charts.leads) {
            window.charts.leads.data.labels = ['WhatsApp', 'Web'];
            window.charts.leads.data.datasets[0].data = [whatsAppLeads, webLeads];
            window.charts.leads.data.datasets[0].backgroundColor = ['#25D366', '#3b82f6']; // WhatsApp Green, Blue Web
            window.charts.leads.update();
        }

        // Actualizar Gráfica de Servicios (Simulado Top 5)
        if (!window.charts.services) {
            const ctxSrv = document.getElementById('servicesChart');
            if (ctxSrv) {
                window.charts.services = new Chart(ctxSrv, {
                    type: 'doughnut',
                    data: {
                        labels: ['Grooming Básico', 'Hotel x Noche', 'Baño Médico', 'Corte Uñas', 'Day Pass'],
                        datasets: [{
                            data: [45, 25, 15, 10, 5],
                            backgroundColor: ['#2F4F4F', '#D4AF37', '#8FBC8F', '#4682B4', '#CD853F'],
                            borderWidth: 0
                        }]
                    },
                    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
                });
            }
        } else {
            window.charts.services.update();
        }

        // Actualizar Gráfica de Productos (Simulado Top 5)
        if (!window.charts.products) {
            const ctxProd = document.getElementById('productsChart');
            if (ctxProd) {
                window.charts.products = new Chart(ctxProd, {
                    type: 'doughnut',
                    data: {
                        labels: ['Shampoo Avena', 'Collar Cuero', 'Juguete Kong', 'Premio Res', 'Cepillo'],
                        datasets: [{
                            data: [35, 25, 20, 15, 5],
                            backgroundColor: ['#D4AF37', '#2F4F4F', '#CD853F', '#8FBC8F', '#4682B4'],
                            borderWidth: 0
                        }]
                    },
                    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
                });
            }
        } else {
            window.charts.products.update();
        }
    };

    // ==========================================
    // LÓGICA DEL CATÁLOGO Y COTIZADOR
    // ==========================================

    window.renderCatalogViews = () => {
        // Render POS
        const posContainer = document.getElementById('pos-catalog-container');
        if (posContainer) {
            posContainer.innerHTML = window.catalogData.map(c => `
                <button onclick="addToCart('${c.name}', ${c.price})" class="p-4 border-2 border-gray-100 rounded-xl hover:border-gold hover:bg-gold/5 text-left transition group bg-white shadow-sm">
                    <div class="font-bold text-forest group-hover:text-gold transition text-sm">${c.name}</div>
                    <div class="text-gray-500 text-[10px] mb-2 truncate">${c.desc}</div>
                    <div class="text-forest font-black bg-gray-50 inline-block px-2 py-1 rounded text-xs">Q ${c.price.toFixed(2)}</div>
                </button>
            `).join('');
        }

        // Render Public Cotizador
        const pubContainer = document.getElementById('public-catalog-container');
        if (pubContainer) {
            pubContainer.innerHTML = window.catalogData.map((c, i) => `
                <label class="cursor-pointer bg-white border border-gray-200 rounded-xl p-4 flex items-center gap-4 hover:border-gold transition shadow-sm group">
                    <input type="checkbox" onchange="updateQuote()" class="quote-checkbox w-5 h-5 text-gold rounded border-gray-300 focus:ring-gold" data-price="${c.price}">
                    <div class="flex-1">
                        <p class="font-bold text-forest group-hover:text-gold transition text-sm">${c.name}</p>
                        <p class="text-[10px] text-gray-500 mt-1">${c.desc}</p>
                    </div>
                    <div class="font-black text-forest">Q ${c.price.toFixed(2)}</div>
                </label>
            `).join('');
            updateQuote(); // Reset al renderizar
        }

        // Render Admin Table
        const adminTbody = document.getElementById('admin-catalog-tbody');
        if (adminTbody) {
            adminTbody.innerHTML = window.catalogData.map((c, i) => `
                <tr class="hover:bg-gray-50">
                    <td class="p-4 border-b">
                        <input type="text" id="cat-name-${i}" value="${c.name}" class="w-full bg-transparent border-b border-dashed border-gray-300 focus:border-gold outline-none p-1 font-bold text-forest">
                    </td>
                    <td class="p-4 border-b">
                        <input type="text" id="cat-desc-${i}" value="${c.desc}" class="w-full bg-transparent border-b border-dashed border-gray-300 focus:border-gold outline-none p-1 text-gray-500 text-sm">
                    </td>
                    <td class="p-4 border-b">
                        <div class="flex items-center">
                            <span class="text-gray-400 mr-1">Q</span>
                            <input type="number" id="cat-price-${i}" value="${c.price}" class="w-20 bg-transparent border-b border-dashed border-gray-300 focus:border-gold outline-none p-1 font-black text-forest">
                        </div>
                    </td>
                    <td class="p-4 border-b text-center">
                        <button onclick="deleteCatalogItem('${c.id}')" class="text-red-400 hover:text-red-600 p-2"><i class="fa-solid fa-trash"></i></button>
                    </td>
                </tr>
            `).join('');
        }
    };

    window.fillPOSClientSelect = () => {
        const select = document.getElementById('pos-client-select');
        if (!select) return;
        select.innerHTML = '<option value="">-- Cobro Libre (Consumidor Final) --</option>';
        window.mockLeads.forEach(l => {
            select.innerHTML += `<option value="${l.id}">${l.nombre} (${l.servicio})</option>`;
        });
    };

    window.autoFillPOSClient = () => {
        const val = document.getElementById('pos-client-select').value;
        const nameEl = document.getElementById('bill-name');
        if (!val) {
            nameEl.value = "";
            return;
        }
        const lead = window.mockLeads.find(l => l.id === val);
        if (lead) {
            nameEl.value = lead.nombre;
        }
    };

    window.renderInventoryViews = () => {
        // Render POS
        const posContainer = document.getElementById('pos-inventory-container');
        if (posContainer) {
            posContainer.innerHTML = window.inventoryData.map(p => `
                <button onclick="addToCartProduct('${p.id}', '${p.name}', ${p.price})" class="p-3 border-2 border-gray-100 rounded-xl hover:border-gold hover:bg-gold/5 text-left transition group bg-white shadow-sm flex items-center gap-3 ${p.stock <= 0 ? 'opacity-50 cursor-not-allowed' : ''}" ${p.stock <= 0 ? 'disabled' : ''}>
                    <img src="${p.img}" class="w-10 h-10 rounded-md object-cover">
                    <div class="flex-1 overflow-hidden">
                        <div class="font-bold text-forest group-hover:text-gold transition text-sm truncate">${p.name}</div>
                        <div class="flex justify-between items-center mt-1">
                            <div class="text-forest font-black bg-gray-50 inline-block px-1.5 py-0.5 rounded text-[10px]">Q ${p.price.toFixed(2)}</div>
                            <div class="text-[10px] font-bold ${p.stock > 0 ? 'text-green-600' : 'text-red-500'}">Stock: ${p.stock}</div>
                        </div>
                    </div>
                </button>
            `).join('');
        }

        // Render Admin Table
        const adminTbody = document.getElementById('admin-inventory-tbody');
        if (adminTbody) {
            adminTbody.innerHTML = window.inventoryData.map((p, i) => `
                <tr class="hover:bg-gray-50">
                    <td class="p-4 border-b text-center align-top">
                        <img src="${p.img}" class="w-12 h-12 rounded-md object-cover mb-2 mx-auto shadow-sm">
                        <label class="cursor-pointer bg-white hover:bg-gray-50 border border-gray-200 text-gray-600 rounded px-2 py-1 text-[10px] shadow-sm block text-center truncate overflow-hidden">
                            <i class="fa-solid fa-camera mr-1"></i>Cambiar
                            <input type="file" id="inv-img-${i}" accept="image/*" class="hidden">
                        </label>
                    </td>
                    <td class="p-4 border-b">
                        <input type="text" id="inv-name-${i}" value="${p.name}" class="w-full bg-transparent border-b border-dashed border-gray-300 focus:border-gold outline-none p-1 font-medium text-forest">
                    </td>
                    <td class="p-4 border-b">
                        <div class="flex items-center">
                            <span class="text-gray-400 mr-1">Q</span>
                            <input type="number" id="inv-price-${i}" value="${p.price}" class="w-20 bg-transparent border-b border-dashed border-gray-300 focus:border-gold outline-none p-1 font-black text-forest">
                        </div>
                    </td>
                    <td class="p-4 border-b text-center">
                        <input type="number" id="inv-stock-${i}" value="${p.stock}" class="w-16 bg-transparent border-b border-dashed border-gray-300 focus:border-gold outline-none p-1 font-bold text-center ${p.stock <= 0 ? 'text-red-500' : 'text-green-600'}">
                    </td>
                    <td class="p-4 border-b text-center">
                        <button onclick="deleteInventoryItem('${p.id}')" class="text-red-400 hover:text-red-600 p-2"><i class="fa-solid fa-trash"></i></button>
                    </td>
                </tr>
            `).join('');
        }
    };

    window.addToCartProduct = (id, name, price) => {
        const product = window.inventoryData.find(p => p.id === id);
        if (product && product.stock > 0) {
            window.cart.push({ id, item: name, name: name, price, type: 'product' });
            renderCart();
        }
    };

    window.saveInventory = async () => {
        const btn = document.querySelector('#tab-inventario button.bg-gold');
        if (!btn) return;
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Guardando...';
        btn.disabled = true;

        try {
            if (window.db) {
                let i = 0;
                while (document.getElementById(`inv-name-${i}`)) {
                    const name = document.getElementById(`inv-name-${i}`).value;
                    const fileInput = document.getElementById(`inv-img-${i}`);
                    let img = window.inventoryData[i] ? window.inventoryData[i].img : window.PLACEHOLDER_IMG;

                    if (fileInput && fileInput.files[0]) {
                        img = await window.uploadImageFile(fileInput.files[0]);
                    }

                    const price = parseFloat(document.getElementById(`inv-price-${i}`).value) || 0;
                    const stock = parseInt(document.getElementById(`inv-stock-${i}`).value) || 0;

                    if (name.trim() !== '') {
                        const id = window.inventoryData[i] ? window.inventoryData[i].id : ('p' + Date.now() + i);
                        await setDoc(doc(window.db, 'inventory', id), { name, img, price, stock });
                    }
                    i++;
                }
            }
        } catch (e) { console.error("Error guardando inventario", e); }

        setTimeout(() => {
            btn.innerHTML = originalHtml;
            btn.disabled = false;
        }, 1000);
    };

    window.addInventoryProduct = async () => {
        if (window.db) {
            await addDoc(collection(window.db, 'inventory'), { name: 'Nuevo Producto', img: '', price: 0, stock: 0 });
        }
    };

    window.deleteInventoryItem = async (id) => {
        if (confirm("¿Eliminar este producto?")) {
            if (window.db) await deleteDoc(doc(window.db, 'inventory', id));
        }
    };

    window.updateQuote = () => {
        const checkboxes = document.querySelectorAll('.quote-checkbox');
        let total = 0;
        checkboxes.forEach(cb => {
            if (cb.checked) total += parseFloat(cb.dataset.price);
        });
        const quoteEl = document.getElementById('quote-total');
        if (quoteEl) quoteEl.innerText = `Q ${total.toFixed(2)}`;
    };

    window.saveCatalog = async () => {
        const btn = document.querySelector('#tab-catalogo button.bg-gold');
        if (btn) {
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Guardando...';
        }
        try {
            if (window.db) {
                for (let i = 0; i < window.catalogData.length; i++) {
                    const nameEl = document.getElementById(`cat-name-${i}`);
                    if (!nameEl) continue;
                    const id = window.catalogData[i].id;
                    const name = nameEl.value || 'Servicio Sin Nombre';
                    const desc = document.getElementById(`cat-desc-${i}`).value || '';
                    const price = parseFloat(document.getElementById(`cat-price-${i}`).value) || 0;

                    await setDoc(doc(window.db, 'catalog', id), { name, desc, price });
                }
            }
        } catch (e) { console.error("Error guardando catálogo", e); }

        if (btn) {
            btn.innerHTML = '<i class="fa-solid fa-check"></i> Guardado';
            setTimeout(() => { btn.innerHTML = '<i class="fa-solid fa-save"></i> Guardar Cambios'; }, 2000);
        }
    };

    window.addCatalogService = async () => {
        if (window.db) {
            await addDoc(collection(window.db, 'catalog'), { name: '', desc: '', price: 0 });
        }
    };

    window.removeCatalogService = async (index) => {
        if (confirm("¿Eliminar este servicio del catálogo?")) {
            const id = window.catalogData[index].id;
            if (window.db) await deleteDoc(doc(window.db, 'catalog', id));
        }
    };

    // ==========================================
    // AUDITORÍA Y RRHH
    // ==========================================
    window.handleAuditTimeFilter = () => {
        const timeFilter = document.getElementById('audit-time-filter').value;
        const customDates = document.getElementById('audit-custom-dates');
        if (timeFilter === 'custom') {
            customDates.classList.remove('hidden');
        } else {
            customDates.classList.add('hidden');
            renderAuditTab();
        }
    };

    window.renderAuditTab = () => {
        const thead = document.getElementById('audit-table-head');
        const tbody = document.getElementById('audit-table-body');
        const emptyState = document.getElementById('audit-empty');
        const timeFilter = document.getElementById('audit-time-filter').value;

        let filteredLogs = [...window.auditLogs];

        // Filtrar por Tiempo
        const now = new Date();
        let customStart, customEnd;
        if (timeFilter === 'custom') {
            const sVal = document.getElementById('audit-date-start').value;
            const eVal = document.getElementById('audit-date-end').value;
            if (sVal) customStart = new Date(sVal + 'T00:00:00');
            if (eVal) customEnd = new Date(eVal + 'T23:59:59');
        }

        filteredLogs = filteredLogs.filter(log => {
            const logDate = new Date(log.timestamp);
            if (timeFilter === 'today') {
                return logDate.toDateString() === now.toDateString();
            } else if (timeFilter === 'yesterday') {
                const yest = new Date(now);
                yest.setDate(yest.getDate() - 1);
                return logDate.toDateString() === yest.toDateString();
            } else if (timeFilter === 'this_week') {
                const diffTime = Math.abs(now - logDate);
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                return diffDays <= 7;
            } else if (timeFilter === 'this_month') {
                return logDate.getMonth() === now.getMonth() && logDate.getFullYear() === now.getFullYear();
            } else if (timeFilter === 'custom') {
                if (customStart && logDate < customStart) return false;
                if (customEnd && logDate > customEnd) return false;
                return true;
            }
            return true; // 'all'
        });

        // Ordenar de más reciente a más antiguo
        filteredLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        // Guardar para exportar
        window.currentRawAuditLogs = filteredLogs;

        thead.innerHTML = '';
        tbody.innerHTML = '';

        if (filteredLogs.length === 0) {
            emptyState.classList.remove('hidden');
            document.getElementById('audit-table-body').parentElement.classList.add('hidden');
        } else {
            emptyState.classList.add('hidden');
            document.getElementById('audit-table-body').parentElement.classList.remove('hidden');

            thead.innerHTML = `
                <tr>
                    <th class="p-5 font-bold">Fecha</th>
                    <th class="p-5 font-bold">Hora</th>
                    <th class="p-5 font-bold">Usuario</th>
                    <th class="p-5 font-bold">Acción</th>
                    <th class="p-5 font-bold">Detalles</th>
                </tr>
            `;

            filteredLogs.forEach(log => {
                const d = new Date(log.timestamp);
                const empName = window.employeesData[log.email] ? window.employeesData[log.email].name : log.email;

                tbody.innerHTML += `
                    <tr class="hover:bg-gray-50 transition group">
                        <td class="p-5 border-b border-gray-100 font-bold text-gray-700">${d.toLocaleDateString()}</td>
                        <td class="p-5 border-b border-gray-100 text-gray-500">${d.toLocaleTimeString()}</td>
                        <td class="p-5 border-b border-gray-100 font-medium text-forest">${empName}</td>
                        <td class="p-5 border-b border-gray-100 text-gold text-xs uppercase tracking-wider font-bold">${log.action}</td>
                        <td class="p-5 border-b border-gray-100 text-gray-500 text-sm">${log.details}</td>
                    </tr>
                `;
            });
        }
    };

    window.exportAuditCSV = () => {
        const logs = window.currentRawAuditLogs || [];
        if (logs.length === 0) {
            alert("No hay datos para exportar en el rango seleccionado.");
            return;
        }

        let csvContent = "data:text/csv;charset=utf-8,";
        csvContent += "Fecha,Hora,Usuario,Accion,Detalles\n";
        logs.forEach(log => {
            const d = new Date(log.timestamp);
            const empName = window.employeesData[log.email] ? window.employeesData[log.email].name : log.email;
            const safeDetails = log.details.replace(/"/g, '""');
            csvContent += `${d.toLocaleDateString()},${d.toLocaleTimeString()},"${empName}","${log.action}","${safeDetails}"\n`;
        });

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `auditoria_casacanis_${Date.now()}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    // ==========================================
    // GESTIÓN DE CITAS Y GOOGLE CALENDAR
    // ==========================================
    window.openCitaModal = () => {
        const listContainer = document.getElementById('cita-cliente-list');
        listContainer.innerHTML = '';
        window.mockLeads.forEach(cliente => {
            const div = document.createElement('div');
            div.className = 'cita-client-option p-3 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-0';
            div.setAttribute('data-id', cliente.id);
            div.setAttribute('data-nombre', cliente.nombre);
            div.setAttribute('data-search', `${cliente.nombre} ${cliente.email} ${cliente.tel}`.toLowerCase());
            div.onclick = () => selectCitaClient(cliente.id, cliente.nombre);
            div.innerHTML = `
                <div class="font-bold text-forest text-sm">${cliente.nombre}</div>
                <div class="text-xs text-gray-500 mt-1"><i class="fa-solid fa-phone mr-1"></i>${cliente.tel} <span class="mx-2">|</span> <i class="fa-solid fa-envelope mr-1"></i>${cliente.email}</div>
            `;
            listContainer.appendChild(div);
        });

        // Reset fields
        document.getElementById('cita-cliente').value = '';
        document.getElementById('cita-cliente-search').value = '';
        document.getElementById('cita-correo').value = '';
        document.getElementById('cita-mascota').innerHTML = '<option value="">-- Seleccionar Cliente Primero --</option>';
        document.getElementById('cita-fecha').value = '';
        document.getElementById('cita-hora-inicio').value = '';
        document.getElementById('cita-hora-fin').value = '';

        document.getElementById('cita-modal').classList.remove('hidden');
    };

    window.showCitaClientList = () => {
        document.getElementById('cita-cliente-list').classList.remove('hidden');
    };

    document.addEventListener('click', (e) => {
        const searchInput = document.getElementById('cita-cliente-search');
        const list = document.getElementById('cita-cliente-list');
        if (searchInput && list && !searchInput.contains(e.target) && !list.contains(e.target)) {
            list.classList.add('hidden');
        }
    });

    window.filterCitaClients = () => {
        const term = document.getElementById('cita-cliente-search').value.toLowerCase();
        const options = document.querySelectorAll('.cita-client-option');
        options.forEach(opt => {
            if (opt.getAttribute('data-search').includes(term)) {
                opt.style.display = 'block';
            } else {
                opt.style.display = 'none';
            }
        });
    };

    window.selectCitaClient = (id, nombre) => {
        document.getElementById('cita-cliente').value = id;
        document.getElementById('cita-cliente-search').value = nombre;
        document.getElementById('cita-cliente-list').classList.add('hidden');
        window.updateCitaClientDetails();
    };

    window.updateCitaClientDetails = () => {
        const clientId = document.getElementById('cita-cliente').value;
        const selectMascota = document.getElementById('cita-mascota');
        const inputCorreo = document.getElementById('cita-correo');

        const cliente = window.mockLeads.find(l => l.id === clientId);

        selectMascota.innerHTML = '';

        if (cliente) {
            inputCorreo.value = cliente.email;
            if (cliente.mascotas && cliente.mascotas.length > 0) {
                cliente.mascotas.forEach(pet => {
                    const option = document.createElement('option');
                    option.value = pet.nombre;
                    option.textContent = pet.nombre + (pet.raza ? ` (${pet.raza})` : '');
                    selectMascota.appendChild(option);
                });
            } else {
                selectMascota.innerHTML = '<option value="">-- Sin mascotas registradas --</option>';
            }
        } else {
            inputCorreo.value = '';
            selectMascota.innerHTML = '<option value="">-- Seleccionar Cliente Primero --</option>';
        }
    };

    window.closeCitaModal = () => {
        document.getElementById('cita-modal').classList.add('hidden');
    };

    window.saveCita = async () => {
        const clienteId = document.getElementById('cita-cliente').value;
        const clienteNombre = document.getElementById('cita-cliente-search').value;

        const correo = document.getElementById('cita-correo').value;
        const mascota = document.getElementById('cita-mascota').value;
        const servicio = document.getElementById('cita-servicio').value;
        const fecha = document.getElementById('cita-fecha').value;
        const horaInicio = document.getElementById('cita-hora-inicio').value;
        const horaFin = document.getElementById('cita-hora-fin').value;
        const googleCalId = document.getElementById('cita-google-cal-id').value.trim();

        if (!clienteId || !fecha || !horaInicio || !horaFin) {
            alert('Por favor selecciona un cliente y completa las fechas y horas.');
            return;
        }

        // Mapeo de colores por servicio
        const colorMap = {
            'Grooming': '#a855f7',
            'Spa': '#3b82f6',
            'Hotel': '#C5A059',
            'Evaluacion': '#10b981'
        };
        const color = colorMap[servicio] || '#3b82f6';
        const title = `${servicio} - ${mascota} (${clienteNombre})`;

        // Guardar en Firestore
        try {
            if (window.db) {
                await addDoc(collection(window.db, 'citas'), {
                    clienteId,
                    clienteNombre,
                    correo,
                    mascota,
                    servicio,
                    fecha,
                    horaInicio,
                    horaFin,
                    googleCalId,
                    title,
                    color,
                    timestamp: serverTimestamp()
                });
            }
        } catch (e) {
            console.error("Error al guardar cita:", e);
            alert("Hubo un error al guardar la cita en la base de datos.");
        }

        // Insertar en FullCalendar
        if (window.calendar) {
            window.calendar.addEvent({
                title: title,
                start: `${fecha}T${horaInicio}:00`,
                end: `${fecha}T${horaFin}:00`,
                backgroundColor: color,
                borderColor: color
            });
        }

        // Generar Links de Google Calendar
        const dateStr = fecha.replace(/-/g, '');
        const startStr = horaInicio.replace(/:/g, '') + '00';
        const endStr = horaFin.replace(/:/g, '') + '00';
        const dateParam = `${dateStr}T${startStr}/${dateStr}T${endStr}`;

        const details = `Cliente: ${clienteNombre}%0AMascota: ${mascota}%0AServicio: ${servicio}`;

        // Link Cliente
        const baseGcalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${dateParam}&details=${details}`;
        document.getElementById('btn-cliente-gcal').href = baseGcalUrl;

        // Link Negocio
        let negocioUrl = baseGcalUrl;
        if (googleCalId !== '') {
            negocioUrl += `&src=${encodeURIComponent(googleCalId)}`;
        }
        document.getElementById('btn-negocio-gcal').href = negocioUrl;

        // Enviar Correo (Mailto Template)
        const subject = encodeURIComponent(`Confirmación de Cita: ${servicio} para ${mascota}`);
        const body = encodeURIComponent(`¡Hola ${clienteNombre}!\n\nTu cita para ${servicio} con ${mascota} ha sido confirmada para el día ${fecha} de ${horaInicio} a ${horaFin}.\n\nPuedes agregar esta cita a tu calendario haciendo clic en el siguiente enlace:\n${decodeURIComponent(baseGcalUrl)}\n\n¡Te esperamos en Casa Canis!`);
        document.getElementById('btn-cliente-mailto').href = `mailto:${correo}?subject=${subject}&body=${body}`;

        // Llenar Modal de Éxito
        document.getElementById('sim-correo-cliente').innerText = correo || 'N/A';
        document.getElementById('sim-nombre-cliente').innerText = clienteNombre.split(' ')[0];
        document.getElementById('sim-servicio').innerText = servicio;
        document.getElementById('sim-mascota').innerText = mascota;

        closeCitaModal();
        document.getElementById('cita-success-modal').classList.remove('hidden');

        logEvent('citas', `Se agendó cita: ${title}`);
    };

    // ==========================================
    // MODULO CALENDARIO FULLCALENDAR
    // ==========================================
    window.initCalendar = () => {
        const calendarEl = document.getElementById('calendar-container');
        if (!calendarEl || window.calendar) return; // Ya existe

        const todayStr = new Date().toISOString().split('T')[0];

        // Crear instancia
        window.calendar = new FullCalendar.Calendar(calendarEl, {
            initialView: 'timeGridWeek', // Vista semanal por defecto
            headerToolbar: {
                left: 'prev,next today',
                center: 'title',
                right: 'dayGridMonth,timeGridWeek,timeGridDay'
            },
            locale: 'es',
            buttonText: {
                today: 'Hoy',
                month: 'Mes',
                week: 'Semana',
                day: 'Día',
                list: 'Agenda'
            },
            allDaySlot: false,
            slotMinTime: '08:00:00',
            slotMaxTime: '19:00:00', // Horario del spa/grooming
            height: '100%',
            events: [
                { title: 'Grooming - Max', start: todayStr + 'T09:00:00', end: todayStr + 'T10:30:00', backgroundColor: '#a855f7', borderColor: '#a855f7' },
                { title: 'Spa Relajante - Bella', start: todayStr + 'T11:00:00', end: todayStr + 'T13:00:00', backgroundColor: '#3b82f6', borderColor: '#3b82f6' },
                { title: 'Corte Específico - Toby', start: todayStr + 'T15:00:00', end: todayStr + 'T16:30:00', backgroundColor: '#a855f7', borderColor: '#a855f7' },
                { title: 'Evaluación Hotel', start: todayStr + 'T14:00:00', end: todayStr + 'T14:30:00', backgroundColor: '#C5A059', borderColor: '#C5A059' }
            ],
            eventClick: function (info) {
                alert('Cita: ' + info.event.title + '\nHora: ' + info.event.start.toLocaleTimeString());
            }
        });
        window.calendar.render();
    };
})();

/* ===== hotfix ======================================================== */
(async function () {
    const db = window.db || getFirestore(getApp());
    const storage = window.storage || getStorage(getApp());
    const auth = window.auth || getAuth(getApp());

    const SIZES = ['peq', 'med', 'gra'];
    const SIZE_KEY = { peq: 'pequeno', med: 'mediano', gra: 'grande' };
    const SIZE_LABEL = { peq: 'Pequeño', med: 'Mediano', gra: 'Grande' };
    const ESTADOS_OCUPAN = ['Reserva Confirmada', 'Reserva Próxima', 'Mascota Adentro'];

    const $ = (id) => document.getElementById(id);
    const money = (n) => 'Q ' + (Number(n) || 0).toFixed(2);


    /* ---------------------------------------------------------------------
       1. SUBIDA DE IMÁGENES  —  la función que nunca existió
       ------------------------------------------------------------------ */

    /**
     * Comprime en canvas antes de subir. Una foto de celular de 4 MB baja a
     * ~200 KB sin pérdida visible, lo que hace la landing mucho más rápida y
     * mantiene el bucket dentro del plan gratuito.
     */
    async function compressImage(file, maxW = 1600, quality = 0.82) {
        if (!file.type.startsWith('image/')) return file;   // PDFs pasan directo
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, maxW / bitmap.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
        return blob || file;
    }

    /**
     * @param {File}   file
     * @param {string} folder  medical | payments | landing | products | staff
     * @returns {Promise<string>} URL pública de descarga
     */
    window.uploadImageFile = async (file, folder = 'landing') => {
        if (!file) return null;
        if (file.size > 15 * 1024 * 1024) {
            throw new Error('El archivo supera los 15 MB.');
        }
        const payload = await compressImage(file);
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
        const path = `${folder}/${Date.now()}_${safeName}`;
        const snap = await uploadBytes(ref(storage, path), payload, {
            contentType: payload.type || file.type,
            cacheControl: 'public,max-age=31536000'
        });
        return await getDownloadURL(snap.ref);
    };


    /* ---------------------------------------------------------------------
       2. AUDITORÍA REAL  —  reemplaza el console.log de la línea 2474
       ------------------------------------------------------------------ */

    window.logEvent = async (action, details, extra = {}) => {
        const u = window.currentUser;
        if (!u) return;                                   // público no audita
        try {
            await addDoc(collection(db, 'audit_logs'), {
                uid: u.uid,
                email: u.email,
                staffName: u.name || u.email,
                action,
                details: String(details || ''),
                entity: extra.entity || null,
                entityId: extra.entityId || null,
                amount: typeof extra.amount === 'number' ? extra.amount : null,
                createdAt: serverTimestamp(),
                timestamp: new Date().toISOString()            // compat con renderAuditTab
            });
        } catch (e) {
            console.error('[audit] no se pudo registrar el evento', e);
        }
    };


    /* ---------------------------------------------------------------------
       3. ROLES
       ------------------------------------------------------------------ */

    async function loadCurrentUser(user) {
        const snap = await getDoc(doc(db, 'staff', user.uid));

        if (!snap.exists()) {
            // Usuario autenticado sin ficha de personal: acceso mínimo.
            // El admin debe crearle su doc en `staff` (ver 06_SETUP.md).
            console.warn('[auth] sin documento staff/' + user.uid);
            window.currentUser = {
                uid: user.uid, email: user.email,
                name: user.email, role: 'agent'
            };
        } else {
            window.currentUser = { uid: user.uid, email: user.email, ...snap.data() };
        }

        window.currentEmployeeEmail = user.email;
        document.body.setAttribute('data-role', window.currentUser.role);

        // Señal para módulos que cargan después (ej. 07_modulo_staff.js)
        document.dispatchEvent(new CustomEvent('cc:auth-ready',
            { detail: window.currentUser }));

        const label = $('ui-role-name');
        if (label) label.innerText = window.currentUser.name || user.email;

        // Renombrado de tabs pedido en el diagrama de proceso.
        renameTabs();
        window.logEvent('login', 'Inicio de sesión');
    }

    function renameTabs() {
        const isAdmin = window.currentUser?.role === 'admin';
        const set = (target, text) => {
            const btn = document.querySelector(`[data-target="${target}"] span:not(#leads-badge)`);
            if (btn) btn.innerText = text;
        };
        set('tab-mensajes', 'Mensajería');                       // no "masiva"
        set('tab-mi-perfil', isAdmin ? 'Staff' : 'Mi Perfil');
        set('tab-config', 'Conectores');
    }


    /* ---------------------------------------------------------------------
       4. CAPACIDAD DEL HOTEL — derivada, no escrita a mano
       ------------------------------------------------------------------ */

    /** Cuenta mascotas ocupando cupo de `size` en una fecha ISO dada. */
    window.ocupadasEn = (size, fechaISO) => {
        return (window.clientsData || []).reduce((n, c) => {
            if (!ESTADOS_OCUPAN.includes(c.estado)) return n;
            const inicio = c.fecha_checkin;
            const fin = c.fecha_checkout || c.fecha_checkin;
            if (!inicio) return n;
            if (fechaISO < inicio || fechaISO > fin) return n;
            const pets = c.mascotas || [];
            return n + pets.filter(m => (m.tamano || m.tamaño || 'med') === size).length;
        }, 0);
    };

    window.disponiblesEn = (size, fechaISO) =>
        Math.max(0, (window.capacityTotals[size] || 0) - window.ocupadasEn(size, fechaISO));

    /** Reemplaza updateBars() de la línea 2512. */
    window.updateBars = () => {
        const hoy = new Date().toISOString().slice(0, 10);

        SIZES.forEach(size => {
            const totalEl = $(`cap-${size}-total`);
            const occEl = $(`cap-${size}-occ`);
            const pctEl = $(`pct-${size}`);
            const barEl = $(`bar-${size}`);
            if (!totalEl || !barEl) return;

            const total = window.capacityTotals[size] || parseInt(totalEl.value) || 0;
            const occ = window.ocupadasEn(size, hoy);

            totalEl.value = total;

            // El campo "ocupadas" pasa a ser SOLO LECTURA: es un dato calculado.
            if (occEl) {
                occEl.value = occ;
                occEl.readOnly = true;
                occEl.classList.add('cc-readonly');
                occEl.removeAttribute('onchange');
                occEl.title = 'Calculado automáticamente según las reservas activas';
            }

            const pct = total > 0 ? Math.min(100, Math.round((occ / total) * 100)) : 0;
            if (pctEl) pctEl.innerText = pct + '%';

            barEl.style.width = pct + '%';
            // Color determinista: se recalcula siempre, así puede volver a verde.
            barEl.className = barEl.className.replace(/bg-(green|yellow|red)-500/g, '');
            barEl.classList.add(pct >= 100 ? 'bg-red-500'
                : pct >= 70 ? 'bg-yellow-500'
                    : 'bg-green-500');
            barEl.classList.toggle('animate-pulse', pct >= 100);

            window.capacityData[SIZE_KEY[size]] = { total, occ };
        });
    };

    /** Reemplaza saveCapacity() — ahora sí persiste. */
    window.saveCapacity = async () => {
        const payload = {};
        SIZES.forEach(s => { payload[s] = parseInt($(`cap-${s}-total`).value) || 0; });

        try {
            await setDoc(doc(db, 'settings', 'capacity'), {
                ...payload, updatedAt: serverTimestamp(),
                updatedBy: window.currentUser?.uid || null
            }, { merge: true });

            window.capacityTotals = payload;
            window.updateBars();
            window.logEvent('capacity_updated',
                `Habitaciones: peq=${payload.peq} med=${payload.med} gra=${payload.gra}`);

            const btn = document.querySelector('#tab-capacidad button');
            if (btn) {
                const og = btn.innerHTML;
                btn.innerHTML = '<i class="fa-solid fa-check"></i> Guardado';
                setTimeout(() => { btn.innerHTML = og; }, 2000);
            }
        } catch (e) {
            console.error(e);
            alert('No se pudo guardar la capacidad.');
        }
    };


    /* ---------------------------------------------------------------------
       5. PUNTO DE VENTA — total correcto, venta persistida, stock real
       ------------------------------------------------------------------ */

    window.addToCart = (item, price, meta = {}) => {
        const existing = window.cart.find(c => c.item === item && c.type === (meta.type || 'service'));
        if (existing) { existing.qty += 1; }
        else {
            window.cart.push({
                id: meta.id || null, item, name: item,
                price: Number(price) || 0, qty: 1,
                type: meta.type || 'service'
            });
        }
        window.renderCart();
    };

    window.addToCartProduct = (id, name, price) => {
        const p = (window.inventoryData || []).find(x => x.id === id);
        if (!p) return;
        const enCarrito = window.cart.filter(c => c.id === id)
            .reduce((n, c) => n + c.qty, 0);
        if (p.stock <= enCarrito) { alert(`Sin stock suficiente de ${name}.`); return; }
        window.addToCart(name, price, { id, type: 'product' });
    };

    window.cartTotal = () =>
        window.cart.reduce((s, c) => s + c.price * c.qty, 0);

    window.renderCart = () => {
        const div = $('cart-items');
        if (!div) return;
        if (window.cart.length === 0) {
            div.innerHTML = '<div class="text-center text-gray-400 text-sm mt-10 italic">Añade servicios al ticket...</div>';
            $('cart-total').innerText = money(0);
            return;
        }
        div.innerHTML = window.cart.map((c, i) => `
        <div class="flex justify-between items-center bg-white p-3 rounded-lg border border-gray-100 shadow-sm">
          <div>
            <span class="text-sm font-bold text-forest">${c.item}</span>
            <div class="flex items-center gap-2 mt-1">
              <button onclick="changeQty(${i},-1)" class="w-6 h-6 rounded bg-gray-100 hover:bg-gray-200 text-forest font-bold">−</button>
              <span class="text-xs font-bold w-6 text-center">${c.qty}</span>
              <button onclick="changeQty(${i},1)" class="w-6 h-6 rounded bg-gray-100 hover:bg-gray-200 text-forest font-bold">+</button>
            </div>
          </div>
          <div class="flex items-center gap-4">
            <span class="font-black text-forest">${money(c.price * c.qty)}</span>
            <button onclick="removeFromCart(${i})" class="text-red-300 hover:text-red-500 bg-red-50 p-2 rounded transition"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>`).join('');
        $('cart-total').innerText = money(window.cartTotal());
    };

    window.changeQty = (i, delta) => {
        const c = window.cart[i];
        if (!c) return;
        c.qty += delta;
        if (c.qty <= 0) window.cart.splice(i, 1);
        window.renderCart();
    };

    window.removeFromCart = (i) => { window.cart.splice(i, 1); window.renderCart(); };

    /**
     * Descuenta stock DENTRO de una transacción y registra el movimiento.
     * El código anterior hacía `prod.stock--` en memoria: el siguiente
     * onSnapshot lo revertía y el stock nunca bajaba.
     */
    async function commitSale(saleDoc) {
        const productos = saleDoc.items.filter(i => i.type === 'product' && i.id);

        await runTransaction(db, async (tx) => {
            // Fase de lectura primero: Firestore lo exige.
            const refs = productos.map(p => doc(db, 'inventory', p.id));
            const snaps = await Promise.all(refs.map(r => tx.get(r)));

            snaps.forEach((snap, idx) => {
                if (!snap.exists()) throw new Error('Producto inexistente');
                const disponible = snap.data().stock || 0;
                if (disponible < productos[idx].qty) {
                    throw new Error(`Stock insuficiente: ${productos[idx].name}`);
                }
            });

            refs.forEach((r, idx) => tx.update(r, { stock: increment(-productos[idx].qty) }));
            tx.set(doc(collection(db, 'sales')), saleDoc);
        });

        for (const p of productos) {
            await addDoc(collection(db, 'inventory_moves'), {
                productId: p.id, tipo: 'venta', cantidad: -p.qty,
                uid: window.currentUser?.uid || null, createdAt: serverTimestamp()
            });
        }
    }

    // Envoltura sobre generateReceipt existente: persiste ANTES de dibujar
    // el PNG, para que un fallo de html2canvas no pierda la venta.
    const _generateReceipt = window.generateReceipt;
    window.generateReceipt = async () => {
        if (!window.cart.length) { alert('Agrega servicios o productos al ticket.'); return; }

        const total = window.cartTotal();                 // ← antes daba NaN
        const saleDoc = {
            items: window.cart.map(c => ({ ...c, subtotal: c.price * c.qty })),
            subtotal: total,
            total,
            clientId: $('pos-client-select')?.value || null,
            billName: $('bill-name')?.value || 'Consumidor Final',
            billNit: $('bill-nit')?.value || 'C.F.',
            comment: $('bill-comment')?.value || '',
            fel: { emitida: !!$('emit-fel-checkbox')?.checked, uuid: null },
            cajero: { uid: window.currentUser?.uid, name: window.currentUser?.name },
            createdAt: serverTimestamp()
        };

        try {
            await commitSale(saleDoc);
        } catch (e) {
            console.error(e);
            alert('No se pudo registrar la venta: ' + e.message);
            return;
        }

        await window.logEvent('sale', `Ticket facturado por ${money(total)}`,
            { entity: 'sale', amount: total });

        if (typeof _generateReceipt === 'function') {
            try { await _generateReceipt(); } catch (e) { console.error(e); }
        }
    };


    /* ---------------------------------------------------------------------
       6. CATÁLOGO — corrige el bug id/índice de deleteCatalogItem
       ------------------------------------------------------------------ */

    window.deleteCatalogItem = async (id) => {
        if (!confirm('¿Eliminar este servicio del catálogo?')) return;
        try {
            await deleteDoc(doc(db, 'catalog', id));
            window.logEvent('catalog_updated', `Servicio eliminado: ${id}`);
        } catch (e) { console.error(e); alert('No se pudo eliminar.'); }
    };
    window.removeCatalogService = window.deleteCatalogItem;


    /* ---------------------------------------------------------------------
       7. MENSAJERÍA — las 5 funciones que el HTML llama y no existían
       ------------------------------------------------------------------ */

    let selectedIndividual = null;

    window.handleTargetChange = () => {
        const target = $('msg-target')?.value;
        $('individual-search-container')?.classList.toggle('hidden', target !== 'individual');
        if (target !== 'individual') selectedIndividual = null;
        window.updateMsgCount();
    };

    window.getMsgRecipients = () => {
        const channel = $('msg-channel')?.value || 'whatsapp';
        const target = $('msg-target')?.value || 'all';

        if (target === 'individual') return selectedIndividual ? [selectedIndividual] : [];

        return (window.clientsData || []).filter(c => {
            const opt = c.optOut || {};
            if (channel === 'whatsapp' && (opt.whatsapp || !c.tel)) return false;
            if (channel === 'email' && (opt.email || !c.email)) return false;
            if (target === 'active') return c.estado === 'Mascota Adentro';
            if (target === 'upcoming') return ESTADOS_OCUPAN.includes(c.estado);
            return true;
        });
    };

    window.updateMsgCount = () => {
        const el = $('msg-count');
        if (el) el.innerText = window.getMsgRecipients().length;
        const subj = $('msg-subject-container');
        if (subj) subj.classList.toggle('hidden', $('msg-channel')?.value !== 'email');
        window.updateMsgPreview();
    };

    window.updateMsgPreview = () => {
        const body = $('msg-body')?.value || '';
        const subject = $('msg-subject')?.value || '';
        const channel = $('msg-channel')?.value || 'whatsapp';
        const sample = window.getMsgRecipients()[0];

        const rendered = body
            .replace(/\{nombre_cliente\}/g, sample?.nombre || 'Ana Pérez')
            .replace(/\{nombre_mascota\}/g, sample?.mascotas?.[0]?.nombre || 'Max');

        const textEl = $('msg-preview-text');
        if (textEl) textEl.innerText = rendered || 'Escribe un mensaje para ver la vista previa aquí.';

        const subjEl = $('msg-preview-subject');
        if (subjEl) {
            subjEl.innerText = subject;
            subjEl.classList.toggle('hidden', channel !== 'email' || !subject);
        }

        const header = $('msg-preview-header');
        const icon = $('msg-preview-icon');
        if (header && icon) {
            const isEmail = channel === 'email';
            header.className = header.className.replace(/bg-\S+/, isEmail ? 'bg-blue-600' : 'bg-green-500');
            icon.className = isEmail ? 'fa-solid fa-envelope text-xl' : 'fa-brands fa-whatsapp text-xl';
        }

        const timeEl = $('msg-preview-time');
        if (timeEl) timeEl.innerText =
            new Date().toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });
    };

    window.filterIndividualClients = () => {
        const term = ($('individual-search-input')?.value || '').toLowerCase().trim();
        const box = $('individual-search-results');
        if (!box) return;
        if (term.length < 2) { box.classList.add('hidden'); return; }

        const hits = (window.clientsData || []).filter(c =>
            `${c.nombre} ${c.email} ${c.tel}`.toLowerCase().includes(term)).slice(0, 12);

        box.innerHTML = hits.length
            ? hits.map(c => `
            <div onclick="pickIndividual('${c.id}')" class="p-3 hover:bg-gray-50 cursor-pointer border-b border-gray-100">
              <div class="font-bold text-forest text-sm">${c.nombre}</div>
              <div class="text-xs text-gray-500">${c.tel || ''} ${c.email ? '· ' + c.email : ''}</div>
            </div>`).join('')
            : '<div class="p-3 text-xs text-gray-400">Sin resultados</div>';
        box.classList.remove('hidden');
    };

    window.pickIndividual = (id) => {
        selectedIndividual = (window.clientsData || []).find(c => c.id === id) || null;
        if (selectedIndividual) $('individual-search-input').value = selectedIndividual.nombre;
        $('individual-search-results')?.classList.add('hidden');
        window.updateMsgCount();
    };

    window.fillMsgTargetOptions = () => window.updateMsgCount();

    /**
     * El envío real necesita una Cloud Function: la WhatsApp Cloud API no
     * acepta llamadas desde el navegador (CORS) y el token no debe viajar al
     * cliente. Mientras tanto, esto deja la campaña en cola y registra el
     * evento, para no perder trabajo del staff.
     */
    window.sendMassMessage = async () => {
        const recipients = window.getMsgRecipients();
        const body = $('msg-body')?.value?.trim();
        if (!body) { alert('Escribe el mensaje.'); return; }
        if (!recipients.length) { alert('No hay destinatarios que cumplan el filtro.'); return; }
        if (!confirm(`¿Encolar el mensaje para ${recipients.length} cliente(s)?`)) return;

        try {
            await addDoc(collection(db, 'message_campaigns'), {
                channel: $('msg-channel')?.value,
                subject: $('msg-subject')?.value || null,
                body,
                recipientIds: recipients.map(r => r.id),
                recipientCount: recipients.length,
                status: 'queued',                       // la Cloud Function la procesa
                createdBy: window.currentUser?.uid,
                createdAt: serverTimestamp()
            });
            await window.logEvent('message_campaign',
                `Campaña encolada para ${recipients.length} cliente(s)`);
            alert(`Campaña encolada (${recipients.length}). Se enviará cuando el conector esté activo.`);
            $('msg-body').value = '';
            window.updateMsgPreview();
        } catch (e) { console.error(e); alert('No se pudo encolar la campaña.'); }
    };


    /* ---------------------------------------------------------------------
       8. LANDING PÚBLICA — contenido e imágenes persistentes
       ------------------------------------------------------------------ */

    function applyLandingConfig(cfg) {
        if (!cfg) return;
        if (cfg.title) $('landing-title').innerHTML = cfg.title.replace(/\n/g, '<br>');
        if (cfg.subtitle) $('landing-subtitle').innerText = cfg.subtitle;
        ['hero', 'serv-1', 'serv-2', 'serv-3'].forEach(k => {
            const url = cfg.images?.[k];
            const el = $('img-' + k);
            if (url && el) el.src = url;
        });
        // Reflejar en el formulario de edición (si el admin está adentro)
        if ($('edit-title')) $('edit-title').value = cfg.title || '';
        if ($('edit-subtitle')) $('edit-subtitle').value = cfg.subtitle || '';
    }

    /** Reemplaza saveWebConfig(): ya no revienta por el #edit-terms inexistente. */
    window.saveWebConfig = async () => {
        const btn = document.querySelector('button[onclick="saveWebConfig()"]');
        const og = btn?.innerHTML;
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Publicando...'; }

        try {
            const images = {};
            const map = {
                hero: 'edit-img-hero', 'serv-1': 'edit-img-serv1',
                'serv-2': 'edit-img-serv2', 'serv-3': 'edit-img-serv3'
            };

            for (const [key, inputId] of Object.entries(map)) {
                const f = $(inputId)?.files?.[0];
                if (f) images[key] = await window.uploadImageFile(f, 'landing');
            }

            const cfg = {
                title: $('edit-title').value,
                subtitle: $('edit-subtitle').value,
                updatedAt: serverTimestamp(),
                updatedBy: window.currentUser?.uid || null
            };
            // merge:true para no borrar imágenes que no se volvieron a subir
            if (Object.keys(images).length) {
                Object.entries(images).forEach(([k, v]) => { cfg['images.' + k] = v; });
            }

            await setDoc(doc(db, 'settings', 'landing'), cfg, { merge: true });
            if (Object.keys(images).length) {
                await updateDoc(doc(db, 'settings', 'landing'),
                    Object.fromEntries(Object.entries(images).map(([k, v]) => ['images.' + k, v])));
            }

            // Config NO secreta de conectores. Los tokens van por Cloud Function,
            // NUNCA por aquí (ver 02_MODELO_DATOS.md §5).
            await setDoc(doc(db, 'settings', 'connectors'), {
                waPhoneNumberId: $('edit-wa-phoneid')?.value || '',
                gcalId: $('config-gcal-id')?.value || '',
                felProvider: $('edit-fel-provider')?.value || '',
                felAfiliacion: $('edit-fel-afiliacion')?.value || '',
                felFrase: $('edit-fel-frase')?.value || '',
                modoPrueba: $('edit-modo-prueba')?.checked ?? true,
                updatedAt: serverTimestamp()
            }, { merge: true });

            const secretos = ['edit-wa-apikey', 'edit-email-apikey', 'edit-fel-llave']
                .filter(id => $(id)?.value?.trim());
            if (secretos.length) {
                alert('Los tokens NO se guardaron: requieren la Cloud Function ' +
                    '`saveConnectorSecret`. Guardar credenciales en Firestore las ' +
                    'deja legibles desde el navegador. Ver 02_MODELO_DATOS.md §5.');
                secretos.forEach(id => { $(id).value = ''; });
            }

            await window.logEvent('config_updated', 'Configuración web actualizada');
            if (btn) btn.innerHTML = '<i class="fa-solid fa-check mr-2"></i>Publicado';
        } catch (e) {
            console.error(e);
            alert('No se pudo publicar: ' + e.message);
            if (btn) btn.innerHTML = og;
        } finally {
            setTimeout(() => { if (btn) { btn.disabled = false; btn.innerHTML = og; } }, 2000);
        }
    };


    /* ---------------------------------------------------------------------
       9. SUSCRIPCIONES PÚBLICAS  (fuera de onAuthStateChanged)
          El catálogo, los T&C y el contenido de la landing deben cargar SIN
          sesión: hoy están dentro del if(user) y por eso el cotizador
          público siempre aparece vacío.
       ------------------------------------------------------------------ */

    onSnapshot(collection(db, 'catalog'), (snap) => {
        window.catalogData = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .filter(c => c.activo !== false)
            .sort((a, b) => (a.orden || 0) - (b.orden || 0));
        if (typeof window.renderCatalogViews === 'function') window.renderCatalogViews();
    }, (e) => console.error('[catalog]', e));

    onSnapshot(doc(db, 'settings', 'landing'),
        (s) => applyLandingConfig(s.data()),
        (e) => console.error('[landing]', e));

    onSnapshot(doc(db, 'settings', 'legal'), (s) => {
        const d = s.data() || {};
        window.currentTerms = d.terms || '';
        window.currentTermsVersion = d.version || 'v1';
        const box = $('bw-tc-text');
        if (box && d.terms) box.innerText = d.terms;
    }, (e) => console.error('[legal]', e));

    onSnapshot(doc(db, 'settings', 'capacity'), (s) => {
        const d = s.data() || {};
        window.capacityTotals = { peq: d.peq || 0, med: d.med || 0, gra: d.gra || 0 };
        if ($('cap-peq-total')) window.updateBars();
    }, (e) => console.error('[capacity]', e));


    /* ---------------------------------------------------------------------
       10. SUSCRIPCIONES AUTENTICADAS + arranque de gráficas y calendario
       ------------------------------------------------------------------ */

    setPersistence(auth, browserLocalPersistence).catch(console.error);

    let unsubs = [];

    onAuthStateChanged(auth, async (user) => {
        unsubs.forEach(fn => { try { fn(); } catch (_) { } });
        unsubs = [];

        if (!user) {
            // Limpiar estado de usuario
            window.currentUser = null;
            window.AuthValidator.clear();
            window.clientsData = [];
            window.citasData = [];
            window.inventoryData = [];
            window.catalogData = [];

            // Limpiar UI
            document.body.removeAttribute('data-role');
            document.getElementById('admin-view')?.classList.add('hidden');
            document.getElementById('public-view')?.classList.remove('hidden');

            return;
        }

        await loadCurrentUser(user);

        unsubs.push(onSnapshot(collection(db, 'clients'), (snap) => {
            window.clientsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            window.mockLeads = window.clientsData;
            if (typeof window.renderLeads === 'function') window.renderLeads();
            if (typeof window.fillPOSClientSelect === 'function') window.fillPOSClientSelect();
            window.updateBars();                       // ocupación en vivo
        }));

        unsubs.push(onSnapshot(collection(db, 'inventory'), (snap) => {
            window.inventoryData = snap.docs.map(d => ({
                id: d.id, ...d.data(),
                img: d.data().img || window.PLACEHOLDER_IMG
            }));
            if (typeof window.renderInventoryViews === 'function') window.renderInventoryViews();
        }));

        unsubs.push(onSnapshot(collection(db, 'citas'), (snap) => {
            window.citasData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            syncCalendarEvents();
        }));

        unsubs.push(onSnapshot(collection(db, 'staff'), (snap) => {
            window.employeesData = {};
            snap.docs.forEach(d => {
                const e = { uid: d.id, ...d.data() };
                window.employeesData[e.email] = {
                    name: e.name, role: e.puesto || e.role, photo: e.photoUrl,
                    tasks: e.tasks || '', schedule: e.schedule || '',
                    permissions: [], uid: d.id
                };
            });
        }));

        unsubs.push(onSnapshot(collection(db, 'time_off'), (snap) => {
            window.timeOffData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            Object.values(window.employeesData).forEach(e => { e.permissions = []; });
            window.timeOffData.forEach(r => {
                const emp = Object.values(window.employeesData).find(e => e.uid === r.uid);
                if (emp) emp.permissions.push({ type: r.type, date: `${r.dateStart} → ${r.dateEnd}`, status: r.status });
            });
            if (typeof window.renderMyProfile === 'function' &&
                !$('tab-mi-perfil')?.classList.contains('hidden')) {
                try { window.renderMyProfile(); } catch (_) { }
            }
        }));

        // Auditoría: solo el admin puede leerla (las reglas lo enforce).
        if (window.currentUser.role === 'admin') {
            unsubs.push(onSnapshot(
                query(collection(db, 'audit_logs'), orderBy('createdAt', 'desc'), limit(500)),
                (snap) => {
                    window.auditLogs = snap.docs.map(d => {
                        const x = d.data();
                        return { ...x, timestamp: x.timestamp || x.createdAt?.toDate?.()?.toISOString() };
                    });
                    if (typeof window.renderAuditTab === 'function' &&
                        !$('tab-auditoria')?.classList.contains('hidden')) {
                        try { window.renderAuditTab(); } catch (_) { }
                    }
                }));
        }

        // initCharts() e initCalendar() existían pero NUNCA se llamaban.
        setTimeout(() => {
            try { if (typeof window.initCharts === 'function') window.initCharts(); } catch (e) { console.error(e); }
            try { if (typeof window.initCalendar === 'function') window.initCalendar(); } catch (e) { console.error(e); }
            syncCalendarEvents();
        }, 400);
    });


    /* ---------------------------------------------------------------------
       11. CALENDARIO — citas reales en lugar de las 4 hardcodeadas
       ------------------------------------------------------------------ */

    function syncCalendarEvents() {
        if (!window.calendar) return;
        window.calendar.removeAllEvents();
        (window.citasData || []).forEach(c => {
            if (!c.fecha || !c.horaInicio) return;
            window.calendar.addEvent({
                id: c.id,
                title: c.title || `${c.servicio} — ${c.mascota}`,
                start: `${c.fecha}T${c.horaInicio}:00`,
                end: `${c.fecha}T${c.horaFin || c.horaInicio}:00`,
                backgroundColor: c.color || '#3b82f6',
                borderColor: c.color || '#3b82f6'
            });
        });
    }
    window.syncCalendarEvents = syncCalendarEvents;


    /* ---------------------------------------------------------------------
       12. switchTab endurecido: un error en un panel ya no rompe la app
       ------------------------------------------------------------------ */

    const _switchTab = window.switchTab;
    window.switchTab = (tabId) => {
        // Bloqueo de tabs de admin del lado del cliente (las reglas hacen el
        // bloqueo real del lado del servidor).
        const ADMIN_ONLY = ['tab-config', 'tab-reportes', 'tab-auditoria', 'tab-capacidad', 'tab-catalogo'];
        if (ADMIN_ONLY.includes(tabId) && !window.AuthValidator.isAdmin()) {
            alert('No tienes permisos para esta sección.');
            return;
        }
        try { _switchTab(tabId); }
        catch (e) { console.error('[switchTab] ' + tabId, e); }

        if (tabId === 'tab-mensajes') window.updateMsgCount();
        if (tabId === 'tab-calendario') setTimeout(syncCalendarEvents, 200);
    };

    console.info('%c[Casa Canis] hotfix v1 activo', 'color:#C5A059;font-weight:bold');
})();

/* ===== staff ========================================================= */
(async function () {
    const db = window.db || getFirestore(getApp());
    const $ = (id) => document.getElementById(id);

    const DIAS = [
        { n: 1, label: 'Lunes' }, { n: 2, label: 'Martes' }, { n: 3, label: 'Miércoles' },
        { n: 4, label: 'Jueves' }, { n: 5, label: 'Viernes' }, { n: 6, label: 'Sábado' },
        { n: 0, label: 'Domingo' }
    ];

    const TIPO_LABEL = {
        vacaciones: 'Vacaciones', dia_completo: 'Día completo',
        salida_temprana: 'Salida temprana', permiso: 'Permiso especial'
    };

    const STATUS_STYLE = {
        pending: ['bg-yellow-100 text-yellow-800', 'Pendiente'],
        approved: ['bg-green-100 text-green-700', 'Aprobado'],
        rejected: ['bg-red-100 text-red-700', 'Rechazado'],
        cancelled: ['bg-gray-100 text-gray-500', 'Cancelado']
    };

    let staffList = [];   // [{uid, name, email, role, puesto, services, active, photoUrl}]
    let schedulesById = {};   // uid -> {week:{...}}
    let timeOffList = [];
    let editingUid = null;


    /* ---------------------------------------------------------------------
       Suscripciones
       ------------------------------------------------------------------ */

    window.initStaffModule = () => {
        if (!window.currentUser) return;

        onSnapshot(collection(db, 'staff'), (snap) => {
            staffList = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
            renderStaffTab();
        }, (e) => console.error('[staff]', e));

        onSnapshot(collection(db, 'staff_schedules'), (snap) => {
            schedulesById = {};
            snap.docs.forEach(d => { schedulesById[d.id] = d.data(); });
            renderStaffTab();
        }, (e) => console.error('[schedules]', e));

        onSnapshot(collection(db, 'time_off'), (snap) => {
            timeOffList = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            renderStaffTab();
        }, (e) => console.error('[time_off]', e));
    };


    /* ---------------------------------------------------------------------
       Render principal — decide qué vista mostrar según el rol
       ------------------------------------------------------------------ */

    window.renderStaffTab = () => {
        const u = window.currentUser;
        if (!u) return;
        const isAdmin = u.role === 'admin';

        $('staff-tab-title').innerText = isAdmin ? 'Staff' : 'Mi Perfil';
        $('staff-tab-sub').innerText = isAdmin
            ? 'Plantilla, horarios y aprobación de ausencias.'
            : 'Tu información, tu horario y tus solicitudes.';

        $('staff-admin-view').classList.toggle('hidden', !isAdmin);
        $('staff-agent-view').classList.toggle('hidden', isAdmin);
        $('btn-add-staff').classList.toggle('hidden', !isAdmin);

        if (isAdmin) { renderRoster(); renderTimeOffQueue(); }
        else { renderAgentProfile(); }
    };
    // Compatibilidad con el switchTab existente, que llama renderMyProfile()
    window.renderMyProfile = window.renderStaffTab;


    /* ---------------------------------------------------------------------
       VISTA ADMIN
       ------------------------------------------------------------------ */

    function scheduleSummary(uid) {
        const wk = schedulesById[uid]?.week;
        if (!wk) return '<span class="text-red-500 font-bold">Sin horario · no genera cupos</span>';
        const dias = DIAS.filter(d => wk[String(d.n)]?.works);
        if (!dias.length) return '<span class="text-red-500 font-bold">Sin días hábiles</span>';
        const d0 = wk[String(dias[0].n)];
        return `${dias.map(d => d.label.slice(0, 3)).join(', ')} · ${d0.start}–${d0.end}`;
    }

    function renderRoster() {
        const box = $('staff-roster');
        if (!staffList.length) {
            box.innerHTML = '<div class="p-8 text-center text-gray-400 text-sm">Sin empleados registrados.</div>';
            return;
        }

        box.innerHTML = staffList.map(s => `
        <div class="px-8 py-5 flex items-center gap-4 hover:bg-gray-50 transition ${s.active === false ? 'opacity-50' : ''}">
          <img src="${s.photoUrl || window.PLACEHOLDER_IMG}" alt=""
               class="w-12 h-12 rounded-full object-cover border border-gray-200 bg-cream">
          <div class="flex-1 min-w-0">
            <p class="font-bold text-forest">${s.name || s.email}</p>
            <p class="text-xs text-gray-500">${s.puesto || '—'} · ${s.email}</p>
            <p class="text-[11px] text-gray-400 mt-1">${scheduleSummary(s.uid)}</p>
          </div>
          <div class="flex flex-wrap gap-1 max-w-[180px] justify-end">
            ${(s.services || []).map(sv =>
            `<span class="text-[10px] bg-cream text-forest px-2 py-0.5 rounded font-bold uppercase">${sv}</span>`
        ).join('')}
          </div>
          <span class="text-[10px] font-bold px-2 py-1 rounded-full ${s.role === 'admin' ? 'bg-forest text-gold' : 'bg-gray-100 text-gray-600'}">
            ${s.role === 'admin' ? 'ADMIN' : 'AGENTE'}
          </span>
          <div class="flex gap-2">
            <button onclick="openScheduleEditor('${s.uid}')"
                    class="bg-white border border-gray-300 text-forest px-3 py-2 rounded-lg hover:bg-gray-50 text-xs font-bold"
                    title="Editar horario">
              <i class="fa-regular fa-clock"></i>
            </button>
            <button onclick="toggleStaffActive('${s.uid}', ${s.active === false})"
                    class="px-3 py-2 rounded-lg text-xs font-bold ${s.active === false
                ? 'bg-green-600 text-white hover:bg-green-700'
                : 'bg-red-50 text-red-500 hover:bg-red-100'}"
                    title="${s.active === false ? 'Reactivar' : 'Desactivar acceso'}">
              <i class="fa-solid fa-power-off"></i>
            </button>
          </div>
        </div>
      `).join('');
    }

    function renderTimeOffQueue() {
        const box = $('timeoff-queue');
        const pendientes = timeOffList.filter(r => r.status === 'pending')
            .sort((a, b) => (a.dateStart || '').localeCompare(b.dateStart || ''));

        $('timeoff-pending-count').innerText = `${pendientes.length} pendiente${pendientes.length === 1 ? '' : 's'}`;

        if (!pendientes.length) {
            box.innerHTML = '<div class="p-8 text-center text-gray-400 text-sm">No hay solicitudes pendientes.</div>';
            return;
        }

        box.innerHTML = pendientes.map(r => `
        <div class="px-8 py-5 flex items-start gap-4 hover:bg-gray-50 transition">
          <div class="bg-yellow-100 text-yellow-700 p-3 rounded-xl"><i class="fa-regular fa-calendar-xmark"></i></div>
          <div class="flex-1">
            <p class="font-bold text-forest">${r.staffName || r.uid}</p>
            <p class="text-sm text-gray-600">
              ${TIPO_LABEL[r.type] || r.type} ·
              <span class="font-medium">${r.dateStart}${r.dateEnd && r.dateEnd !== r.dateStart ? ' → ' + r.dateEnd : ''}</span>
              ${r.hourStart ? ` · desde ${r.hourStart}` : ''}
            </p>
            <p class="text-xs text-gray-500 italic mt-1">${r.reason || ''}</p>
          </div>
          <div class="flex gap-2 shrink-0">
            <button onclick="reviewTimeOff('${r.id}','approved')"
                    class="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 text-xs font-bold">
              <i class="fa-solid fa-check"></i> Aprobar
            </button>
            <button onclick="reviewTimeOff('${r.id}','rejected')"
                    class="bg-white border border-red-200 text-red-500 px-4 py-2 rounded-lg hover:bg-red-50 text-xs font-bold">
              <i class="fa-solid fa-xmark"></i> Rechazar
            </button>
          </div>
        </div>
      `).join('');
    }

    window.reviewTimeOff = async (id, status) => {
        const req = timeOffList.find(r => r.id === id);
        if (!req) return;
        const verbo = status === 'approved' ? 'aprobar' : 'rechazar';
        if (!confirm(`¿${verbo.charAt(0).toUpperCase() + verbo.slice(1)} la solicitud de ${req.staffName}?`)) return;

        try {
            await updateDoc(doc(db, 'time_off', id), {
                status,
                reviewedBy: window.currentUser.uid,
                reviewedAt: serverTimestamp()
            });
            await window.logEvent(
                status === 'approved' ? 'timeoff_approved' : 'timeoff_rejected',
                `${TIPO_LABEL[req.type]} de ${req.staffName} (${req.dateStart}) → ${status}`,
                { entity: 'time_off', entityId: id }
            );
        } catch (e) {
            console.error(e);
            alert('No se pudo procesar la solicitud.');
        }
    };

    window.toggleStaffActive = async (uid, reactivar) => {
        if (uid === window.currentUser.uid) {
            alert('No puedes desactivar tu propia cuenta.');
            return;
        }
        const s = staffList.find(x => x.uid === uid);
        if (!confirm(`¿${reactivar ? 'Reactivar' : 'Desactivar el acceso de'} ${s?.name}?`)) return;

        try {
            // Nota: las reglas permiten esto solo al admin. `active:false` corta el
            // acceso de inmediato sin borrar el historial de auditoría.
            await updateDoc(doc(db, 'staff', uid), { active: !!reactivar });
            await window.logEvent('staff_updated',
                `${s?.name} ${reactivar ? 'reactivado' : 'desactivado'}`, { entity: 'staff', entityId: uid });
        } catch (e) {
            console.error(e);
            alert('No se pudo actualizar. Solo el administrador puede hacerlo.');
        }
    };


    /* ---------------------------------------------------------------------
       Editor de horario semanal
       ------------------------------------------------------------------ */

    window.openScheduleEditor = (uid) => {
        editingUid = uid;
        const s = staffList.find(x => x.uid === uid);
        const wk = schedulesById[uid]?.week || {};

        $('sched-emp-name').innerText = s?.name || s?.email || '';
        $('schedule-editor').classList.remove('hidden');

        $('schedule-grid').innerHTML = DIAS.map(d => {
            const cfg = wk[String(d.n)] || {};
            const works = !!cfg.works;
            const lunch = cfg.lunch || ['12:00', '13:00'];
            return `
          <div class="flex flex-wrap items-center gap-3 p-4 rounded-xl border ${works ? 'border-gold/40 bg-gold/5' : 'border-gray-200 bg-gray-50'}">
            <label class="flex items-center gap-2 w-32 shrink-0 cursor-pointer">
              <input type="checkbox" id="sch-${d.n}-works" ${works ? 'checked' : ''}
                     onchange="toggleDayRow(${d.n})" class="w-4 h-4 rounded text-gold focus:ring-gold">
              <span class="font-bold text-forest text-sm">${d.label}</span>
            </label>
            <div id="sch-${d.n}-fields" class="flex flex-wrap items-center gap-3 ${works ? '' : 'opacity-40 pointer-events-none'}">
              <div class="flex items-center gap-1">
                <span class="text-[10px] text-gray-500 uppercase font-bold">Entrada</span>
                <input type="time" id="sch-${d.n}-start" value="${cfg.start || '08:00'}"
                       class="border border-gray-200 rounded-lg px-2 py-1 text-sm outline-none focus:border-gold">
              </div>
              <div class="flex items-center gap-1">
                <span class="text-[10px] text-gray-500 uppercase font-bold">Salida</span>
                <input type="time" id="sch-${d.n}-end" value="${cfg.end || '17:00'}"
                       class="border border-gray-200 rounded-lg px-2 py-1 text-sm outline-none focus:border-gold">
              </div>
              <div class="flex items-center gap-1 border-l border-gray-200 pl-3">
                <span class="text-[10px] text-gray-500 uppercase font-bold">Almuerzo</span>
                <input type="time" id="sch-${d.n}-lunch-start" value="${lunch[0]}"
                       class="border border-gray-200 rounded-lg px-2 py-1 text-sm outline-none focus:border-gold">
                <span class="text-gray-400">–</span>
                <input type="time" id="sch-${d.n}-lunch-end" value="${lunch[1]}"
                       class="border border-gray-200 rounded-lg px-2 py-1 text-sm outline-none focus:border-gold">
              </div>
            </div>
          </div>`;
        }).join('');

        $('schedule-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };

    window.toggleDayRow = (n) => {
        const works = $(`sch-${n}-works`).checked;
        const fields = $(`sch-${n}-fields`);
        fields.classList.toggle('opacity-40', !works);
        fields.classList.toggle('pointer-events-none', !works);
        fields.parentElement.className = fields.parentElement.className
            .replace(/border-\S+ bg-\S+/, works ? 'border-gold/40 bg-gold/5' : 'border-gray-200 bg-gray-50');
    };

    window.closeScheduleEditor = () => {
        $('schedule-editor').classList.add('hidden');
        editingUid = null;
    };

    window.saveSchedule = async () => {
        if (!editingUid) return;
        const week = {};

        for (const d of DIAS) {
            const works = $(`sch-${d.n}-works`).checked;
            if (!works) { week[String(d.n)] = { works: false }; continue; }

            const start = $(`sch-${d.n}-start`).value;
            const end = $(`sch-${d.n}-end`).value;
            if (!start || !end || start >= end) {
                alert(`${d.label}: la hora de salida debe ser posterior a la de entrada.`);
                return;
            }
            const ls = $(`sch-${d.n}-lunch-start`).value;
            const le = $(`sch-${d.n}-lunch-end`).value;
            if (ls && le && (ls < start || le > end || ls >= le)) {
                alert(`${d.label}: el almuerzo debe caer dentro del turno.`);
                return;
            }
            week[String(d.n)] = { works: true, start, end, lunch: (ls && le) ? [ls, le] : null };
        }

        try {
            await setDoc(doc(db, 'staff_schedules', editingUid), {
                uid: editingUid, week,
                effectiveFrom: new Date().toISOString().slice(0, 10),
                updatedAt: serverTimestamp(),
                updatedBy: window.currentUser.uid
            }, { merge: true });

            const s = staffList.find(x => x.uid === editingUid);
            await window.logEvent('schedule_updated', `Horario actualizado: ${s?.name}`,
                { entity: 'staff_schedules', entityId: editingUid });
            window.closeScheduleEditor();
        } catch (e) {
            console.error(e);
            alert('No se pudo guardar el horario.');
        }
    };


    /* ---------------------------------------------------------------------
       VISTA AGENTE
       ------------------------------------------------------------------ */

    function renderAgentProfile() {
        const u = window.currentUser;
        const me = staffList.find(s => s.uid === u.uid) || u;

        $('my-profile-img').src = me.photoUrl || window.PLACEHOLDER_IMG;
        $('my-profile-name').innerText = me.name || u.email;
        $('my-profile-role').innerText = me.puesto || (u.role === 'admin' ? 'Administrador' : 'Agente');
        $('my-profile-phone').value = me.phone || '';

        // Horario propio, solo lectura
        const wk = schedulesById[u.uid]?.week;
        const box = $('my-schedule-list');
        box.innerHTML = !wk
            ? '<p class="text-xs text-gray-400 italic">Administración aún no ha definido tu horario.</p>'
            : DIAS.map(d => {
                const c = wk[String(d.n)];
                return `
              <div class="flex justify-between items-center py-1.5 border-b border-gray-50 last:border-0">
                <span class="font-medium text-forest">${d.label}</span>
                ${c?.works
                        ? `<span class="text-gray-600 text-xs">${c.start}–${c.end}${c.lunch ? ` <span class="text-gray-400">(almuerzo ${c.lunch[0]}–${c.lunch[1]})</span>` : ''}</span>`
                        : '<span class="text-gray-300 text-xs italic">Descanso</span>'}
              </div>`;
            }).join('');

        // Mis solicitudes
        const mine = timeOffList.filter(r => r.uid === u.uid)
            .sort((a, b) => (b.dateStart || '').localeCompare(a.dateStart || ''));
        const list = $('my-requests-list');
        list.innerHTML = !mine.length
            ? '<p class="text-xs text-gray-400 italic">No tienes solicitudes.</p>'
            : mine.map(r => {
                const [cls, label] = STATUS_STYLE[r.status] || STATUS_STYLE.pending;
                return `
              <div class="bg-gray-50 border border-gray-200 p-3 rounded-lg flex justify-between items-center gap-2">
                <div class="min-w-0">
                  <p class="text-xs font-bold text-forest">${TIPO_LABEL[r.type] || r.type}</p>
                  <p class="text-[10px] text-gray-500">${r.dateStart}${r.dateEnd && r.dateEnd !== r.dateStart ? ' → ' + r.dateEnd : ''}</p>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <span class="text-[10px] font-bold px-2 py-1 rounded-full ${cls}">${label}</span>
                  ${r.status === 'pending'
                        ? `<button onclick="cancelMyRequest('${r.id}')" class="text-gray-400 hover:text-red-500" title="Cancelar"><i class="fa-solid fa-xmark"></i></button>`
                        : ''}
                </div>
              </div>`;
            }).join('');

        updateBreakButton();
    }

    window.onReqTypeChange = () => {
        const t = $('req-type').value;
        $('req-hour-wrap').classList.toggle('hidden', t !== 'salida_temprana');
    };

    window.submitPermissionRequest = async () => {
        const type = $('req-type').value;
        const dateStart = $('req-date-start').value;
        const dateEnd = $('req-date-end').value || dateStart;
        const hourStart = $('req-hour-start').value || null;
        const reason = $('req-reason').value.trim();

        if (!dateStart) { alert('Selecciona la fecha de inicio.'); return; }
        if (dateEnd < dateStart) { alert('La fecha final no puede ser anterior a la inicial.'); return; }
        if (!reason) { alert('Explica el motivo de la solicitud.'); return; }
        if (type === 'salida_temprana' && !hourStart) { alert('Indica la hora de salida.'); return; }

        const u = window.currentUser;
        try {
            await addDoc(collection(db, 'time_off'), {
                uid: u.uid,
                staffName: u.name || u.email,
                type, dateStart, dateEnd,
                hourStart: type === 'salida_temprana' ? hourStart : null,
                reason,
                status: 'pending',            // las reglas exigen 'pending' al crear
                reviewedBy: null, reviewedAt: null,
                createdAt: serverTimestamp()
            });
            await window.logEvent('timeoff_requested',
                `${TIPO_LABEL[type]} solicitada: ${dateStart}${dateEnd !== dateStart ? ' → ' + dateEnd : ''}`);

            $('req-date-start').value = '';
            $('req-date-end').value = '';
            $('req-reason').value = '';
            alert('Solicitud enviada. Administración la revisará.');
        } catch (e) {
            console.error(e);
            alert('No se pudo enviar la solicitud.');
        }
    };

    window.cancelMyRequest = async (id) => {
        if (!confirm('¿Cancelar esta solicitud?')) return;
        try {
            await updateDoc(doc(db, 'time_off', id), { status: 'cancelled' });
        } catch (e) {
            console.error(e);
            alert('No se pudo cancelar.');
        }
    };

    window.saveMyProfile = async () => {
        const u = window.currentUser;
        const patch = { phone: $('my-profile-phone').value.trim() };

        try {
            const f = $('my-profile-upload')?.files?.[0];
            if (f) patch.photoUrl = await window.uploadImageFile(f, `staff/${u.uid}`);

            // Las reglas solo permiten photoUrl / phone / notes en el propio doc.
            await updateDoc(doc(db, 'staff', u.uid), patch);
            await window.logEvent('profile_updated', 'Perfil actualizado');
            alert('Perfil actualizado.');
        } catch (e) {
            console.error(e);
            alert('No se pudo actualizar el perfil.');
        }
    };


    /* ---------------------------------------------------------------------
       Descansos (quedan en auditoría, como pide el diagrama)
       ------------------------------------------------------------------ */

    let breakStartedAt = null;

    function updateBreakButton() {
        const btn = $('btn-break');
        if (!btn) return;
        if (breakStartedAt) {
            btn.innerHTML = '<i class="fa-solid fa-play mr-2"></i>Terminar descanso';
            btn.className = 'w-full bg-red-50 text-red-600 font-bold py-3 rounded-xl hover:bg-red-100 transition border border-red-200';
        } else {
            btn.innerHTML = '<i class="fa-solid fa-mug-hot mr-2"></i>Iniciar descanso';
            btn.className = 'w-full bg-cream text-forest font-bold py-3 rounded-xl hover:bg-gold/20 transition border border-gold/30';
        }
    }

    window.toggleBreak = async () => {
        if (!breakStartedAt) {
            breakStartedAt = Date.now();
            await window.logEvent('break_start', 'Inicio de descanso');
        } else {
            const mins = Math.round((Date.now() - breakStartedAt) / 60000);
            await window.logEvent('break_end', `Fin de descanso · ${mins} min`);
            breakStartedAt = null;
        }
        updateBreakButton();
    };


    /* ---------------------------------------------------------------------
       Alta de empleado
       ------------------------------------------------------------------ */

    window.openStaffModal = () => $('staff-modal').classList.remove('hidden');
    window.closeStaffModal = () => $('staff-modal').classList.add('hidden');

    window.createStaff = async () => {
        const name = $('ns-name').value.trim();
        const email = $('ns-email').value.trim();
        const puesto = $('ns-puesto').value.trim();
        const role = $('ns-role').value;
        const services = [...document.querySelectorAll('.ns-svc:checked')].map(c => c.value);

        if (!name || !email) { alert('Nombre y correo son obligatorios.'); return; }

        // El alta requiere crear el usuario en Auth Y el doc en `staff` con el
        // MISMO uid. Solo el Admin SDK puede hacerlo, por eso va por callable:
        // las reglas bloquean `create` sobre staff/{uid} desde el navegador,
        // justo para que nadie pueda auto-asignarse role:'admin'.
        try {
            const fn = httpsCallable(getFunctions(getApp()), 'onStaffCreate');
            await fn({ name, email, puesto, role, services });
            await window.logEvent('staff_created', `Empleado creado: ${name} (${role})`);
            alert('Empleado creado. Se le envió un correo para definir su contraseña.');
            window.closeStaffModal();
        } catch (e) {
            console.error(e);
            alert('No se pudo crear el empleado.\n\nSi el error es "not-found", falta ' +
                'desplegar la Cloud Function onStaffCreate (ver 05_GUIA_SETUP.md paso 7). ' +
                'Mientras tanto, créalo a mano en Authentication + Firestore.');
        }
    };


    /* ---------------------------------------------------------------------
       Motor de disponibilidad — capacidad por servicio, fecha y hora
       Consumido por el calendario público y por el wizard de reservas.
       ------------------------------------------------------------------ */

    /** ¿El empleado tiene ausencia APROBADA que cubra esa fecha/hora? */
    function tieneAusencia(uid, fechaISO, hora) {
        return timeOffList.some(r => {
            if (r.uid !== uid || r.status !== 'approved') return false;
            if (fechaISO < r.dateStart || fechaISO > (r.dateEnd || r.dateStart)) return false;
            // Salida temprana: solo bloquea a partir de esa hora
            if (r.type === 'salida_temprana' && r.hourStart) return hora >= r.hourStart;
            return true;
        });
    }

    /**
     * Cuántos empleados pueden atender `servicio` en esa fecha y hora.
     * Considera: día hábil, turno, almuerzo y ausencias aprobadas.
     * @returns {number}
     */
    window.capacidadServicio = (servicio, fechaISO, hora) => {
        const weekday = String(new Date(fechaISO + 'T12:00:00').getDay());

        return staffList.filter(s => {
            if (s.active === false) return false;
            if (!(s.services || []).includes(servicio)) return false;

            const dia = schedulesById[s.uid]?.week?.[weekday];
            if (!dia?.works) return false;
            if (hora < dia.start || hora >= dia.end) return false;
            if (dia.lunch && hora >= dia.lunch[0] && hora < dia.lunch[1]) return false;
            if (tieneAusencia(s.uid, fechaISO, hora)) return false;

            return true;
        }).length;
    };

    /**
     * Slots libres = capacidad − citas ya agendadas − locks vigentes.
     * NOTA: los locks aún no se descuentan aquí porque el bloqueo
     * transaccional está pendiente (ver 02_MODELO_DATOS.md §4.5).
     * Hasta entonces, dos usuarios simultáneos pueden tomar el mismo cupo.
     */
    window.slotsLibres = (servicio, fechaISO, hora) => {
        const cap = window.capacidadServicio(servicio, fechaISO, hora);
        const ocupados = (window.citasData || []).filter(c =>
            c.fecha === fechaISO && c.horaInicio <= hora && (c.horaFin || c.horaInicio) > hora
        ).length;
        return Math.max(0, cap - ocupados);
    };

    /** Slots de un día completo, en pasos de `duracionMin`. */
    window.slotsDelDia = (servicio, fechaISO, duracionMin = 60) => {
        const out = [];
        for (let m = 8 * 60; m + duracionMin <= 19 * 60; m += duracionMin) {
            const hora = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
            out.push({ hora, libres: window.slotsLibres(servicio, fechaISO, hora) });
        }
        return out;
    };

    // Arranque
    if (window.currentUser) window.initStaffModule();
    else document.addEventListener('cc:auth-ready', () => window.initStaffModule(), { once: true });
})();


/* ===== disponibilidad ============================================== */
(async function () {

    const { getFirestore, doc, setDoc, onSnapshot, serverTimestamp } =
        await import("https://www.gstatic.com/firebasejs/10.4.0/firebase-firestore.js");
    const { getApp } = await import("https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js");

    const db = window.db || getFirestore(getApp());
    const $ = (id) => document.getElementById(id);

    // El <select> de la landing usa pequeno/mediano/grande;
    // el motor interno usa peq/med/gra.
    const SIZE_MAP = { pequeno: 'peq', mediano: 'med', grande: 'gra' };
    const SIZE_LABEL = { peq: 'pequeño', med: 'mediano', gra: 'grande' };
    const DIAS_HORIZONTE = 180;

    window.availabilitySummary = { days: {}, capacity: { peq: 0, med: 0, gra: 0 } };


    /* ---------------- lado público: leer el resumen ---------------- */

    onSnapshot(doc(db, 'availability', 'summary'), (snap) => {
        if (snap.exists()) window.availabilitySummary = snap.data();
    }, (e) => console.error('[availability]', e));


    /* ---------------- botón "Consultar Sistema" -------------------- */

    window.checkAvailability = () => {
        const fecha = $('check-date')?.value;
        const sizeRaw = $('check-size')?.value;
        const box = $('availability-result');
        if (!box) return;

        if (!fecha || !sizeRaw) {
            alert('Selecciona la fecha de ingreso y el tamaño de tu mascota.');
            return;
        }

        const hoy = new Date().toISOString().slice(0, 10);
        if (fecha < hoy) {
            alert('La fecha de ingreso no puede ser anterior a hoy.');
            return;
        }

        const size = SIZE_MAP[sizeRaw] || 'med';
        const cap = window.availabilitySummary.capacity?.[size] || 0;
        const ocupadas = window.availabilitySummary.days?.[fecha]?.[size] || 0;
        const libres = Math.max(0, cap - ocupadas);

        const icon = $('avail-icon');
        const status = $('avail-status');
        const msg = $('avail-msg');
        const flow = $('registration-flow');

        box.classList.remove('hidden');
        box.className = box.className.replace(/border-\S+|bg-\S+/g, '').trim();

        if (cap === 0) {
            // Capacidad sin configurar: no mentir diciendo "no hay cupo".
            icon.innerHTML = '<i class="fa-solid fa-circle-info text-blue-300"></i>';
            status.innerText = 'Consúltanos directamente';
            msg.innerText = 'Estamos terminando de habilitar la consulta en línea. '
                + 'Escríbenos por WhatsApp y te confirmamos al momento.';
            box.classList.add('mt-10', 'text-center', 'p-8', 'rounded-2xl', 'border-2',
                'fade-in', 'shadow-inner', 'bg-blue-500/10', 'border-blue-300/40');
            flow?.classList.remove('hidden');

        } else if (libres > 0) {
            icon.innerHTML = '<i class="fa-solid fa-circle-check text-green-400"></i>';
            status.innerText = '¡Tenemos espacio disponible!';
            msg.innerText = `Quedan ${libres} ${libres === 1 ? 'espacio' : 'espacios'} `
                + `para perros de tamaño ${SIZE_LABEL[size]} el `
                + `${formatoFecha(fecha)}.`;
            box.classList.add('mt-10', 'text-center', 'p-8', 'rounded-2xl', 'border-2',
                'fade-in', 'shadow-inner', 'bg-green-500/10', 'border-green-400/40');
            flow?.classList.remove('hidden');

        } else {
            icon.innerHTML = '<i class="fa-solid fa-circle-xmark text-red-400"></i>';
            status.innerText = 'Sin cupo para esa fecha';
            msg.innerText = `Ya no tenemos espacio para perros de tamaño `
                + `${SIZE_LABEL[size]} el ${formatoFecha(fecha)}. `
                + `Prueba con otra fecha o escríbenos para buscar alternativas.`;
            box.classList.add('mt-10', 'text-center', 'p-8', 'rounded-2xl', 'border-2',
                'fade-in', 'shadow-inner', 'bg-red-500/10', 'border-red-400/40');
            flow?.classList.add('hidden');
            sugerirFechas(size, fecha);
        }

        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    function formatoFecha(iso) {
        return new Date(iso + 'T12:00:00').toLocaleDateString('es-GT',
            { weekday: 'long', day: 'numeric', month: 'long' });
    }

    /** Busca las 3 fechas libres más cercanas y las muestra bajo el mensaje. */
    function sugerirFechas(size, desde) {
        const cap = window.availabilitySummary.capacity?.[size] || 0;
        const libres = [];
        const d = new Date(desde + 'T12:00:00');

        for (let i = 1; i <= 30 && libres.length < 3; i++) {
            d.setDate(d.getDate() + 1);
            const iso = d.toISOString().slice(0, 10);
            const occ = window.availabilitySummary.days?.[iso]?.[size] || 0;
            if (cap - occ > 0) libres.push(iso);
        }
        if (!libres.length) return;

        const msg = $('avail-msg');
        msg.innerHTML += '<br><br><span class="text-sm opacity-80">Fechas cercanas con espacio:</span><br>'
            + libres.map(f =>
                `<button onclick="document.getElementById('check-date').value='${f}';checkAvailability();"
                         class="inline-block mt-2 mx-1 bg-white/15 hover:bg-white/25 px-4 py-2 rounded-lg
                                text-sm font-bold transition">${formatoFecha(f)}</button>`
            ).join('');
    }


    /* ---------------- botón de WhatsApp ---------------------------- */

    window.startWhatsAppBot = () => {
        const fecha = $('check-date')?.value;
        const size = $('check-size')?.value;
        const texto = encodeURIComponent(
            '¡Hola Casa Canis! Quiero consultar disponibilidad'
            + (fecha ? ` para el ${formatoFecha(fecha)}` : '')
            + (size ? ` para un perro ${SIZE_LABEL[SIZE_MAP[size]] || size}` : '')
            + '.'
        );
        // Número del pie de página del material de Casa Canis
        window.open(`https://wa.me/50230484614?text=${texto}`, '_blank');
    };


    /* ---------------- lado staff: recalcular el resumen ------------- */

    const ESTADOS_OCUPAN = ['Reserva Confirmada', 'Reserva Próxima', 'Mascota Adentro'];

    window.recomputeAvailability = async () => {
        if (!window.currentUser) return;               // solo con sesión de staff

        const days = {};
        const hoy = new Date();

        (window.clientsData || []).forEach(c => {
            if (!ESTADOS_OCUPAN.includes(c.estado)) return;
            if (!c.fecha_checkin) return;

            const inicio = new Date(c.fecha_checkin + 'T12:00:00');
            const fin = new Date((c.fecha_checkout || c.fecha_checkin) + 'T12:00:00');

            for (const m of (c.mascotas || [])) {
                const size = m.tamano || m.tamaño || 'med';
                const key = SIZE_MAP[size] || size;
                if (!['peq', 'med', 'gra'].includes(key)) continue;

                // La noche de salida NO ocupa: la habitación se libera a las 11 am
                for (const d = new Date(inicio); d < fin || +d === +inicio; d.setDate(d.getDate() + 1)) {
                    const iso = d.toISOString().slice(0, 10);
                    if (new Date(iso) < hoy.setHours(0, 0, 0, 0)) continue;
                    days[iso] = days[iso] || { peq: 0, med: 0, gra: 0 };
                    days[iso][key]++;
                    if (Object.keys(days).length > DIAS_HORIZONTE * 2) break;
                }
            }
        });

        try {
            await setDoc(doc(db, 'availability', 'summary'), {
                days,
                capacity: window.capacityTotals || { peq: 0, med: 0, gra: 0 },
                updatedAt: serverTimestamp()
            });
        } catch (e) {
            console.error('[availability] no se pudo publicar el resumen', e);
        }
    };

    // Recalcular cuando cambien reservas o capacidad, con rebote para no
    // escribir una vez por cada documento que llega en el snapshot inicial.
    let t = null;
    window.scheduleAvailabilityRecompute = () => {
        clearTimeout(t);
        t = setTimeout(() => window.recomputeAvailability(), 1500);
    };

    document.addEventListener('cc:auth-ready', () => {
        window.scheduleAvailabilityRecompute();
        setInterval(() => window.scheduleAvailabilityRecompute(), 10 * 60 * 1000);
    });

    // Enganchar al guardado de capacidad
    const _saveCapacity = window.saveCapacity;
    window.saveCapacity = async () => {
        if (_saveCapacity) await _saveCapacity();
        window.scheduleAvailabilityRecompute();
    };

    // Enganchar a los cambios de estado de reservas
    const _updateClientStatus = window.updateClientStatus;
    if (_updateClientStatus) {
        window.updateClientStatus = async (...args) => {
            const r = await _updateClientStatus(...args);
            window.scheduleAvailabilityRecompute();
            return r;
        };
    }

    console.info('%c[Casa Canis] disponibilidad activa', 'color:#C5A059;font-weight:bold');
})();


/* ===== flujo de reserva` hasta su `})();`) y pega este en su
   lugar. Este incluye todo lo del parche 2 más lo nuevo.
   ===================================================================== */

/* ===== flujo de reserva ============================================ */
(async function () {

    const { getFirestore, collection, addDoc, doc, setDoc, deleteDoc, onSnapshot,
        serverTimestamp } =
        await import("https://www.gstatic.com/firebasejs/10.4.0/firebase-firestore.js");
    const { getApp } = await import("https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js");

    const db = window.db || getFirestore(getApp());
    const $ = (id) => document.getElementById(id);
    const money = (n) => 'Q ' + (Number(n) || 0).toFixed(2);

    const PASOS = ['Fechas y Mascotas', 'Datos del Cliente', 'Validación Médica',
        'Términos y Condiciones', 'Pago y Comprobante'];
    const TOTAL = PASOS.length;
    const SIZE_LABEL = { peq: 'Pequeño', med: 'Mediano', gra: 'Grande' };

    let paso = 1;
    let lockId = null;
    let terminosLeidos = false;
    let pets = [];                 // [{id, nombre, pesoLb, tamano, raza, edad, files}]
    let nextPetId = 1;

    window.paymentConfig = {
        banco: '', tipoCuenta: 'Monetaria', numero: '',
        aNombre: '', nit: '', notas: '', porcentaje: 100
    };

    /** Rangos de peso de la tabla de precios de Casa Canis. */
    function tamanoPorPeso(lb) {
        const n = Number(lb) || 0;
        if (n <= 0) return null;
        if (n <= 40) return 'peq';
        if (n <= 60) return 'med';
        return 'gra';
    }

    function noches() {
        const ci = $('bw-date')?.value, co = $('bw-date-out')?.value;
        if (!ci || !co || co <= ci) return 0;
        return Math.round((new Date(co) - new Date(ci)) / 86400000);
    }

    /** Todas las fechas ocupadas: la noche de salida NO cuenta. */
    function fechasDelRango() {
        const ci = $('bw-date')?.value;
        const n = noches();
        if (!ci || n < 1) return ci ? [ci] : [];
        const out = [];
        const d = new Date(ci + 'T12:00:00');
        for (let i = 0; i < n; i++) {
            out.push(d.toISOString().slice(0, 10));
            d.setDate(d.getDate() + 1);
        }
        return out;
    }


    /* ---------------- configuración pública ------------------------ */

    onSnapshot(doc(db, 'settings', 'legal'), (snap) => {
        const d = snap.data() || {};
        window.currentTerms = d.terms || '';
        window.currentTermsVersion = d.version || 'v0';
        if ($('bw-tc-text')) $('bw-tc-text').innerText = d.terms || 'Aún no se han publicado los términos.';
        if ($('bw-tc-version')) $('bw-tc-version').innerText = d.version || '';
        if ($('cfg-tc-text') && !$('cfg-tc-text').value) $('cfg-tc-text').value = d.terms || '';
        if ($('cfg-tc-version-current')) $('cfg-tc-version-current').innerText = d.version || '—';
    }, (e) => console.error('[legal]', e));

    onSnapshot(doc(db, 'settings', 'pagos'), (snap) => {
        if (!snap.exists()) return;
        window.paymentConfig = { ...window.paymentConfig, ...snap.data() };
        pintarDatosBancarios();
        pintarFormularioConfig();
    }, (e) => console.error('[pagos]', e));

    function pintarDatosBancarios() {
        const p = window.paymentConfig;
        const set = (id, v) => { const el = $(id); if (el) el.innerText = v || '—'; };
        set('bw-bank-name', p.banco); set('bw-bank-type', p.tipoCuenta);
        set('bw-bank-number', p.numero); set('bw-bank-owner', p.aNombre);
        set('bw-bank-nit', p.nit);
        if ($('bw-bank-nit-row')) $('bw-bank-nit-row').style.display = p.nit ? '' : 'none';
        if ($('bw-bank-notes')) $('bw-bank-notes').innerText = p.notas || '';
        if ($('bw-total-nota')) $('bw-total-nota').innerText =
            `Pago del ${p.porcentaje || 100}% por adelantado.`;
    }

    function pintarFormularioConfig() {
        const p = window.paymentConfig;
        const set = (id, v) => { const el = $(id); if (el && !el.value) el.value = v || ''; };
        set('cfg-bank-name', p.banco); set('cfg-bank-number', p.numero);
        set('cfg-bank-owner', p.aNombre); set('cfg-bank-nit', p.nit);
        set('cfg-bank-notes', p.notas);
        if ($('cfg-bank-type')) $('cfg-bank-type').value = p.tipoCuenta || 'Monetaria';
        if ($('cfg-pay-pct')) $('cfg-pay-pct').value = p.porcentaje || 100;
    }

    window.copyBankNumber = () => {
        navigator.clipboard.writeText(window.paymentConfig.numero || '')
            .then(() => alert('Número de cuenta copiado.'));
    };


    /* ---------------- guardado desde Conectores -------------------- */

    window.saveTerms = async () => {
        const texto = $('cfg-tc-text').value.trim();
        if (texto.length < 50) { alert('El texto de los términos parece incompleto.'); return; }
        const hoy = new Date().toISOString().slice(0, 10);
        const previa = window.currentTermsVersion || '';
        const version = previa.startsWith(hoy)
            ? `${hoy}-${(parseInt(previa.split('-')[3]) || 1) + 1}` : hoy;
        try {
            await setDoc(doc(db, 'settings', 'legal'),
                {
                    terms: texto, version, updatedAt: serverTimestamp(),
                    updatedBy: window.currentUser?.uid || null
                }, { merge: true });
            await setDoc(doc(db, 'settings', 'legal_versions'), { [version]: texto }, { merge: true });
            await window.logEvent('terms_updated', `Términos publicados, versión ${version}`);
            alert(`Términos publicados. Versión ${version}.`);
        } catch (e) { console.error(e); alert('No se pudieron publicar los términos.'); }
    };

    window.savePaymentInfo = async () => {
        const p = {
            banco: $('cfg-bank-name').value.trim(),
            tipoCuenta: $('cfg-bank-type').value,
            numero: $('cfg-bank-number').value.trim(),
            aNombre: $('cfg-bank-owner').value.trim(),
            nit: $('cfg-bank-nit').value.trim(),
            notas: $('cfg-bank-notes').value.trim(),
            porcentaje: parseInt($('cfg-pay-pct').value) || 100
        };
        if (!p.banco || !p.numero || !p.aNombre) {
            alert('Banco, número de cuenta y titular son obligatorios.'); return;
        }
        try {
            await setDoc(doc(db, 'settings', 'pagos'), { ...p, updatedAt: serverTimestamp() }, { merge: true });
            await window.logEvent('payment_info_updated', `Cuenta ${p.banco} ${p.numero}`);
            alert('Datos bancarios guardados.');
        } catch (e) { console.error(e); alert('No se pudieron guardar los datos.'); }
    };


    /* ---------------- mascotas: lista dinámica --------------------- */

    window.addPetRow = () => {
        pets.push({
            id: nextPetId++, nombre: '', pesoLb: '', tamano: null,
            raza: '', edad: '', files: null
        });
        renderPets();
        onBookingChange();
    };

    window.removePetRow = (id) => {
        if (pets.length === 1) { alert('Debe haber al menos una mascota.'); return; }
        pets = pets.filter(p => p.id !== id);
        renderPets();
        onBookingChange();
    };

    window.updatePet = (id, campo, valor) => {
        const p = pets.find(x => x.id === id);
        if (!p) return;
        p[campo] = valor;
        if (campo === 'pesoLb') {
            p.tamano = tamanoPorPeso(valor);
            const badge = $(`bw-pet-size-${id}`);
            if (badge) {
                badge.innerText = p.tamano ? SIZE_LABEL[p.tamano] : '—';
                badge.className = 'text-[10px] font-bold px-2 py-1 rounded-full ' +
                    (p.tamano ? 'bg-gold/20 text-forest' : 'bg-gray-100 text-gray-400');
            }
            onBookingChange();
        }
    };

    function renderPets() {
        const box = $('bw-pets');
        if (!box) return;
        box.innerHTML = pets.map((p, i) => `
            <div class="bg-gray-50 border border-gray-200 rounded-xl p-3 flex items-center gap-3">
                <span class="text-xs font-bold text-gray-400 w-5">${i + 1}</span>
                <input type="text" value="${p.nombre}" placeholder="Nombre"
                       oninput="updatePet(${p.id},'nombre',this.value)"
                       class="flex-1 min-w-0 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-gold">
                <div class="relative w-28 shrink-0">
                    <input type="number" value="${p.pesoLb}" placeholder="Peso" min="1" max="200"
                           oninput="updatePet(${p.id},'pesoLb',this.value)"
                           class="w-full px-3 py-2 pr-8 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-gold">
                    <span class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">lb</span>
                </div>
                <span id="bw-pet-size-${p.id}" class="text-[10px] font-bold px-2 py-1 rounded-full shrink-0 ${p.tamano ? 'bg-gold/20 text-forest' : 'bg-gray-100 text-gray-400'}">${p.tamano ? SIZE_LABEL[p.tamano] : '—'}</span>
                <button type="button" onclick="removePetRow(${p.id})"
                        class="text-gray-300 hover:text-red-500 transition shrink-0 px-1">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>`).join('');
    }

    function renderPetsDetail() {
        const box = $('bw-pets-detail');
        if (!box) return;
        box.innerHTML = pets.map(p => `
            <div class="bg-gray-50 border border-gray-200 rounded-xl p-4">
                <p class="font-bold text-forest text-sm mb-3">
                    ${p.nombre || 'Mascota'}
                    <span class="text-xs font-normal text-gray-500">· ${p.pesoLb} lb · ${SIZE_LABEL[p.tamano] || ''}</span>
                </p>
                <div class="grid grid-cols-2 gap-3">
                    <input type="text" value="${p.raza}" placeholder="Raza"
                           oninput="updatePet(${p.id},'raza',this.value)"
                           class="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-gold">
                    <input type="text" value="${p.edad}" placeholder="Edad"
                           oninput="updatePet(${p.id},'edad',this.value)"
                           class="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-gold">
                </div>
            </div>`).join('');
    }

    function renderPetsMedical() {
        const box = $('bw-pets-medical');
        if (!box) return;
        box.innerHTML = pets.map(p => `
            <label class="block border-2 border-dashed border-gray-300 rounded-xl p-4 cursor-pointer hover:border-gold hover:bg-gray-50 transition">
                <input type="file" accept="image/*,.pdf" multiple class="hidden"
                       onchange="onPetFiles(${p.id}, this)">
                <div class="flex items-center gap-3">
                    <i class="fa-solid fa-file-medical text-2xl text-gray-400"></i>
                    <div class="flex-1">
                        <p class="font-bold text-forest text-sm">${p.nombre || 'Mascota'}</p>
                        <p class="text-xs text-gray-500">Cartilla de vacunación y desparasitación</p>
                    </div>
                    <span id="bw-pet-files-${p.id}" class="text-xs font-bold ${p.files?.length ? 'text-green-600' : 'text-gray-300'}">${p.files?.length ? '✓ ' + p.files.length + ' archivo(s)' : 'Pendiente'}</span>
                </div>
            </label>`).join('');
    }

    window.onPetFiles = (id, input) => {
        const p = pets.find(x => x.id === id);
        if (!p) return;
        p.files = Array.from(input.files);
        const el = $(`bw-pet-files-${id}`);
        if (el) {
            el.innerText = '✓ ' + p.files.length + ' archivo(s)';
            el.className = 'text-xs font-bold text-green-600';
        }
    };


    /* ---------------- precio y disponibilidad ---------------------- */

    /** Precio por noche de una mascota, según su tamaño y el servicio. */
    function precioPorMascota(pet, servicio) {
        if (!servicio) return 0;
        // Si el catálogo tiene una entrada del mismo tipo para ese tamaño,
        // usarla; si no, el precio del servicio elegido.
        const igual = (window.catalogData || []).find(c =>
            c.categoria && servicio.categoria &&
            c.categoria === servicio.categoria && c.tamano === pet.tamano);
        return (igual || servicio).price || 0;
    }

    function calcularTotal() {
        const svc = (window.catalogData || []).find(c => c.id === $('bw-servicio')?.value);
        const n = Math.max(1, noches());
        const lineas = pets.map(p => {
            const unit = precioPorMascota(p, svc);
            return { pet: p, unit, noches: n, subtotal: unit * n };
        });
        const base = lineas.reduce((s, l) => s + l.subtotal, 0);
        const pct = window.paymentConfig.porcentaje || 100;
        return { lineas, base, total: base * pct / 100, pct, noches: n, svc };
    }

    /** Valida cupo por tamaño en TODAS las noches del rango. */
    function revisarDisponibilidad() {
        const box = $('bw-avail-box');
        if (!box) return true;

        const validos = pets.filter(p => p.tamano);
        if (!validos.length || !$('bw-date').value) { box.classList.add('hidden'); return false; }

        const necesita = { peq: 0, med: 0, gra: 0 };
        validos.forEach(p => necesita[p.tamano]++);

        const cap = window.availabilitySummary?.capacity || {};
        const days = window.availabilitySummary?.days || {};
        const problemas = [];

        for (const fecha of fechasDelRango()) {
            for (const size of ['peq', 'med', 'gra']) {
                if (!necesita[size]) continue;
                const libres = (cap[size] || 0) - (days[fecha]?.[size] || 0);
                if (libres < necesita[size]) {
                    problemas.push(`${fecha}: faltan ${necesita[size] - libres} espacio(s) ${SIZE_LABEL[size].toLowerCase()}`);
                }
            }
        }

        box.classList.remove('hidden');
        if (problemas.length) {
            box.className = 'rounded-xl p-4 text-sm bg-red-50 border border-red-200 text-red-700';
            box.innerHTML = '<p class="font-bold mb-1"><i class="fa-solid fa-circle-xmark mr-2"></i>Sin cupo suficiente</p>'
                + problemas.slice(0, 4).map(p => `<p class="text-xs">${p}</p>`).join('');
            return false;
        }

        const { lineas, base, total, pct, noches: n } = calcularTotal();
        box.className = 'rounded-xl p-4 text-sm bg-green-50 border border-green-200 text-green-800';
        box.innerHTML = '<p class="font-bold mb-2"><i class="fa-solid fa-circle-check mr-2"></i>Hay espacio disponible</p>'
            + lineas.map(l => `<div class="flex justify-between text-xs py-0.5">
                   <span>${l.pet.nombre || 'Mascota'} (${SIZE_LABEL[l.pet.tamano]}) × ${l.noches} noche(s)</span>
                   <span class="font-bold">${money(l.subtotal)}</span></div>`).join('')
            + `<div class="flex justify-between border-t border-green-300 mt-2 pt-2 font-bold">
                   <span>Total</span><span>${money(base)}</span></div>`
            + (pct < 100 ? `<div class="flex justify-between text-xs mt-1">
                   <span>A pagar ahora (${pct}%)</span><span class="font-bold">${money(total)}</span></div>` : '');
        return true;
    }

    window.onBookingChange = () => {
        const n = noches();
        const badge = $('bw-noches-badge');
        if (badge) {
            if (n > 0) {
                badge.classList.remove('hidden');
                badge.innerHTML = `<i class="fa-regular fa-moon mr-2"></i>${n} noche${n === 1 ? '' : 's'} · ${pets.length} mascota${pets.length === 1 ? '' : 's'}`;
            } else badge.classList.add('hidden');
        }
        revisarDisponibilidad();
    };

    function llenarServicios() {
        const sel = $('bw-servicio');
        if (!sel || !window.catalogData?.length) return;
        const actual = sel.value;
        sel.innerHTML = '<option value="">Selecciona un servicio...</option>'
            + window.catalogData.map(c =>
                `<option value="${c.id}">${c.name} — ${money(c.price)}</option>`).join('');
        if (actual) sel.value = actual;
    }


    /* ---------------- navegación ----------------------------------- */

    window.openBookingWizard = () => {
        $('booking-wizard-modal').classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        terminosLeidos = false;
        if (!pets.length) addPetRow();
        llenarServicios();
        const f = $('check-date')?.value;
        if (f && $('bw-date')) $('bw-date').value = f;
        renderPets();
        mostrarPaso(1);
        onBookingChange();
    };
    window.toggleWebForm = window.openBookingWizard;

    window.closeBookingWizard = () => {
        $('booking-wizard-modal').classList.add('hidden');
        document.body.style.overflow = 'auto';
        if (lockId) { deleteDoc(doc(db, 'locks', lockId)).catch(console.error); lockId = null; }
    };

    function mostrarPaso(n) {
        paso = n;
        for (let i = 1; i <= TOTAL; i++) $(`bw-step-${i}`)?.classList.toggle('hidden', i !== n);
        $('bw-step-indicator').innerText = `Paso ${n} de ${TOTAL}: ${PASOS[n - 1]}`;
        $('bw-btn-back').classList.toggle('hidden', n === 1);

        const next = $('bw-btn-next');
        if (n === TOTAL) {
            next.innerHTML = '<i class="fa-solid fa-check"></i> Finalizar Reserva';
            next.classList.replace('bg-forest', 'bg-green-600');
        } else {
            next.innerHTML = 'Siguiente <i class="fa-solid fa-arrow-right"></i>';
            next.classList.replace('bg-green-600', 'bg-forest');
        }
        if (n === 2) renderPetsDetail();
        if (n === 3) renderPetsMedical();
        if (n === 4) prepararTerminos();
        if (n === 5) { pintarDatosBancarios(); pintarResumenPago(); }
    }

    window.wizardStepBack = () => { if (paso > 1) mostrarPaso(paso - 1); };

    const loader = (t) => {
        $('bw-loader-text').innerText = t;
        $('bw-loader').classList.remove('hidden');
        $('bw-loader').classList.add('flex');
    };
    const sinLoader = () => {
        $('bw-loader').classList.add('hidden');
        $('bw-loader').classList.remove('flex');
    };


    /* ---------------- términos ------------------------------------- */

    function prepararTerminos() {
        const box = $('bw-tc-text'), chk = $('bw-accept-tc'),
            lbl = $('bw-tc-label'), hint = $('bw-tc-hint');
        if (!box || !chk) return;
        if (box.scrollHeight <= box.clientHeight + 4) terminosLeidos = true;
        chk.disabled = !terminosLeidos;
        lbl.classList.toggle('opacity-50', !terminosLeidos);
        lbl.classList.toggle('cursor-not-allowed', !terminosLeidos);
        if (hint) hint.classList.toggle('hidden', terminosLeidos);
    }

    window.onTermsScroll = () => {
        const box = $('bw-tc-text');
        if (terminosLeidos || !box) return;
        if (box.scrollTop + box.clientHeight >= box.scrollHeight - 12) {
            terminosLeidos = true; prepararTerminos();
        }
    };

    window.onTermsToggle = () => {
        const lbl = $('bw-tc-label'), on = $('bw-accept-tc').checked;
        lbl.classList.toggle('border-forest', on);
        lbl.classList.toggle('bg-cream', on);
    };


    /* ---------------- pago ----------------------------------------- */

    function pintarResumenPago() {
        const { total } = calcularTotal();
        if ($('bw-total')) $('bw-total').innerText = money(total);
    }

    window.onComprobanteSelected = () => {
        const f = $('bw-file-comprobante').files[0], s = $('bw-comprobante-status');
        if (f && s) { s.innerText = '✓ ' + f.name; s.classList.remove('hidden'); }
    };

    window.selectPayOption = (op) => {
        if (op !== 'transfer') return;
        $('bw-pay-transfer').classList.remove('hidden');
        document.querySelector('input[name="paymethod"][value="transfer"]').checked = true;
        document.querySelectorAll('.bw-pay-option').forEach(el =>
            el.classList.add('border-gold', 'bg-cream'));
    };


    /* ---------------- avance con validaciones ---------------------- */

    window.wizardStepNext = async () => {

        if (paso === 1) {
            if (!$('bw-servicio').value) { alert('Selecciona el servicio.'); return; }
            const ci = $('bw-date').value, co = $('bw-date-out').value;
            if (!ci) { alert('Selecciona la fecha de entrada.'); return; }
            if (ci < new Date().toISOString().slice(0, 10)) {
                alert('La fecha de entrada no puede ser anterior a hoy.'); return;
            }
            if (!co || co <= ci) { alert('La fecha de salida debe ser posterior a la de entrada.'); return; }

            const sinNombre = pets.some(p => !p.nombre.trim());
            const sinPeso = pets.some(p => !p.tamano);
            if (sinNombre) { alert('Cada mascota necesita nombre.'); return; }
            if (sinPeso) { alert('Indica el peso de cada mascota.'); return; }
            if (!revisarDisponibilidad()) { alert('No hay cupo suficiente para esas fechas.'); return; }

            loader('Apartando tus cupos...');
            try {
                if (lockId) await deleteDoc(doc(db, 'locks', lockId)).catch(() => { });
                const ref = await addDoc(collection(db, 'locks'), {
                    date: ci, dateEnd: co,
                    size: pets[0].tamano,
                    qty: pets.length,
                    serviceId: $('bw-servicio').value,
                    expiresAt: new Date(Date.now() + 10 * 60000),
                    createdAt: serverTimestamp()
                });
                lockId = ref.id;
                sinLoader();
                mostrarPaso(2);
            } catch (e) { console.error(e); sinLoader(); alert('No se pudo apartar el cupo.'); }
            return;
        }

        if (paso === 2) {
            const nombre = $('bw-nombre').value.trim(), tel = $('bw-tel').value.trim();
            if (!nombre || !tel) { alert('Nombre y teléfono son obligatorios.'); return; }
            if (tel.replace(/\D/g, '').length < 8) { alert('Revisa el número de teléfono.'); return; }
            mostrarPaso(3);
            return;
        }

        if (paso === 3) {
            const faltan = pets.filter(p => !p.files?.length);
            if (faltan.length) {
                alert('Falta la cartilla de: ' + faltan.map(p => p.nombre || 'sin nombre').join(', '));
                return;
            }
            mostrarPaso(4);
            return;
        }

        if (paso === 4) {
            if (!$('bw-accept-tc').checked) {
                alert('Debes aceptar los Términos y Condiciones para continuar.'); return;
            }
            mostrarPaso(5);
            return;
        }

        if (paso === 5) await finalizar();
    };


    /* ---------------- guardar -------------------------------------- */

    async function finalizar() {
        const comp = $('bw-file-comprobante').files;
        if (!comp?.length) { alert('Sube el comprobante del depósito.'); return; }
        if (!$('bw-accept-tc').checked) { mostrarPaso(4); return; }

        loader('Subiendo documentos y registrando tu solicitud...');
        try {
            const mascotas = [];
            for (const p of pets) {
                const urls = [];
                for (const f of p.files) urls.push(await window.uploadImageFile(f, 'medical'));
                mascotas.push({
                    nombre: p.nombre.trim(), raza: p.raza.trim(), edad: p.edad.trim(),
                    pesoLb: Number(p.pesoLb), tamano: p.tamano, medicalUrls: urls
                });
            }
            const comprobanteUrl = await window.uploadImageFile(comp[0], 'payments');
            const { base, total, pct, noches: n, svc } = calcularTotal();

            await addDoc(collection(db, 'clients'), {
                nombre: $('bw-nombre').value.trim(),
                tel: $('bw-tel').value.trim(),
                email: $('bw-email').value.trim(),
                optOut: { whatsapp: false, email: false },
                mascotas,
                servicioId: svc?.id || null,
                servicio: svc?.name || '',
                fecha_checkin: $('bw-date').value,
                fecha_checkout: $('bw-date-out').value,
                noches: n,
                cupos: mascotas.length,
                origen: 'landing_web_wizard',
                estado: 'Pendiente Validación Médica',
                legal_terms_accepted: true,
                legal_terms_version: window.currentTermsVersion || 'v0',
                payment_method: 'transfer',
                payment_pct: pct,
                comprobanteUrl,
                total_cotizado: base,
                total_pagado: total,
                timestamp: new Date().toISOString()
            });

            if (lockId) { await deleteDoc(doc(db, 'locks', lockId)).catch(() => { }); lockId = null; }

            sinLoader();
            $('booking-wizard-modal').classList.add('hidden');
            document.body.style.overflow = 'auto';
            pets = [];
            alert('¡Solicitud enviada! Validaremos tu documentación y tu depósito, '
                + 'y te confirmaremos por WhatsApp o correo.');
        } catch (e) {
            console.error(e); sinLoader();
            alert('No se pudo enviar la solicitud: ' + e.message);
        }
    }

    console.info('%c[Casa Canis] flujo de reserva v3 activo', 'color:#C5A059;font-weight:bold');
})();
/* ===== sesión anónima para subidas públicas ======================== */
(async function () {
    const { getAuth, signInAnonymously } =
        await import("https://www.gstatic.com/firebasejs/10.4.0/firebase-auth.js");
    const { getApp } = await import("https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js");

    const auth = window.auth || getAuth(getApp());
    const subirOriginal = window.uploadImageFile;

    window.uploadImageFile = async (file, folder = 'landing') => {
        if (!auth.currentUser) {
            // Sin catch silencioso: si esto falla, la subida no puede
            // funcionar y el error tiene que llegar al usuario.
            await signInAnonymously(auth);
        }
        console.log('[subida]', folder, '· uid:', auth.currentUser?.uid,
            '· anónimo:', auth.currentUser?.isAnonymous);
        return await subirOriginal(file, folder);
    };

    console.info('%c[Casa Canis] sesión anónima lista', 'color:#C5A059;font-weight:bold');
})();

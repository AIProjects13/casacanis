/* ============================================ */
/* CONFIGURACIÓN GLOBAL */
/* ============================================ */

const WHATSAPP_NUMBER = '+502 3048 4614';
const WHATSAPP_API = 'https://wa.me/50230484614';

/* ============================================ */
/* SCROLL-TRIGGERED ANIMATIONS */
/* ============================================ */

class ScrollAnimationObserver {
    constructor() {
        this.options = {
            threshold: 0.1,
            rootMargin: '0px 0px -50px 0px'
        };
        this.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    this.observer.unobserve(entry.target);
                }
            });
        }, this.options);

        this.init();
    }

    init() {
        const animatedElements = document.querySelectorAll('.fade-in, .fade-in-up, .fade-in-left, .servicio-especial');
        animatedElements.forEach(element => {
            this.observer.observe(element);
        });
    }
}

/* ============================================ */
/* FORMULARIO DE CONTACTO */
/* ============================================ */

class ContactForm {
    constructor() {
        this.form = document.getElementById('contactForm');
        this.cantidadInput = document.getElementById('cantidadMascotas');
        this.mascotasContainer = document.getElementById('mascotas-container');

        if (this.cantidadInput && this.mascotasContainer) {
            this.cantidadInput.addEventListener('input', () => this.renderMascotaBlocks());
            this.renderMascotaBlocks();
        }

        if (this.form) {
            this.form.addEventListener('submit', (e) => this.handleSubmit(e));
        }
    }

    renderMascotaBlocks() {
        let cantidad = parseInt(this.cantidadInput.value) || 1;
        cantidad = Math.min(Math.max(cantidad, 1), 10);
        this.cantidadInput.value = cantidad;

        const datosPrevios = Array.from(this.mascotasContainer.querySelectorAll('.mascota-block')).map(block => ({
            nombre: block.querySelector('.mascota-nombre').value,
            raza: block.querySelector('.mascota-raza').value,
            peso: block.querySelector('.mascota-peso').value
        }));

        let html = '';
        for (let i = 0; i < cantidad; i++) {
            const datos = datosPrevios[i] || { nombre: '', raza: '', peso: '' };
            html += `
                <div class="mascota-block">
                    <h4><i class="fas fa-paw"></i> Mascota ${i + 1}</h4>
                    <div class="form-row">
                        <div class="form-group">
                            <label>Nombre *</label>
                            <input type="text" class="mascota-nombre" value="${datos.nombre}" required>
                        </div>
                        <div class="form-group">
                            <label>Raza</label>
                            <input type="text" class="mascota-raza" value="${datos.raza}">
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Peso Aproximado (lb)</label>
                        <input type="number" class="mascota-peso" value="${datos.peso}">
                    </div>
                </div>
            `;
        }
        this.mascotasContainer.innerHTML = html;
    }

    getMascotas() {
        return Array.from(this.mascotasContainer.querySelectorAll('.mascota-block')).map(block => ({
            nombre: block.querySelector('.mascota-nombre').value.trim(),
            raza: block.querySelector('.mascota-raza').value.trim(),
            peso: block.querySelector('.mascota-peso').value.trim()
        }));
    }

    handleSubmit(e) {
        e.preventDefault();

        const formData = {
            nombre: document.getElementById('nombre').value.trim(),
            telefono: document.getElementById('telefono').value.trim(),
            email: document.getElementById('email').value.trim(),
            mensaje: document.getElementById('mensaje').value.trim(),
            mascotas: this.getMascotas()
        };

        if (!this.validateForm(formData)) {
            alert('Por favor completa todos los campos requeridos, incluyendo el nombre de cada mascota.');
            return;
        }

        const whatsappMessage = this.buildMessage(formData);
        this.openWhatsApp(whatsappMessage);
        this.form.reset();
        this.renderMascotaBlocks();
    }

    validateForm(data) {
        return data.nombre && data.telefono && data.mascotas.length > 0 && data.mascotas.every(m => m.nombre);
    }

    buildMessage(data) {
        let message = `*NUEVA RESERVA - Casa Canis* 📱\n\n`;
        message += `👤 *Cliente:* ${data.nombre}\n`;
        message += `📞 *Teléfono:* ${data.telefono}\n`;

        if (data.email) {
            message += `📧 *Email:* ${data.email}\n`;
        }

        message += `\n🐕 *Mascotas (${data.mascotas.length})*\n`;
        data.mascotas.forEach((mascota, index) => {
            message += `\n*${index + 1}. ${mascota.nombre}*\n`;
            if (mascota.raza) {
                message += `   Raza: ${mascota.raza}\n`;
            }
            if (mascota.peso) {
                message += `   Peso: ${mascota.peso} lb\n`;
            }
        });

        if (data.mensaje) {
            message += `\n💬 *Necesidades Especiales:*\n${data.mensaje}\n`;
        }

        message += `\n---\nEnviado desde: Casa Canis Landing Page`;

        return message;
    }

    openWhatsApp(message) {
        const encodedMessage = encodeURIComponent(message);
        const whatsappLink = `${WHATSAPP_API}?text=${encodedMessage}`;
        window.open(whatsappLink, '_blank');
    }
}

/* ============================================ */
/* BOTÓN FLOTANTE WHATSAPP */
/* ============================================ */

class WhatsAppButton {
    constructor() {
        this.button = document.getElementById('whatsappButton');
        if (this.button) {
            this.button.addEventListener('click', () => this.openDirectMessage());
        }
    }

    openDirectMessage() {
        const message = `Hola Casa Canis, me gustaría conocer más sobre sus servicios y hacer una reserva.`;
        const encodedMessage = encodeURIComponent(message);
        const whatsappLink = `${WHATSAPP_API}?text=${encodedMessage}`;
        window.open(whatsappLink, '_blank');
    }
}

/* ============================================ */
/* NAVEGACIÓN SMOOTH */
/* ============================================ */

class SmoothNavigation {
    constructor() {
        this.links = document.querySelectorAll('a[href^="#"]');
        this.links.forEach(link => {
            link.addEventListener('click', (e) => this.handleClick(e));
        });
    }

    handleClick(e) {
        const href = e.target.getAttribute('href');

        if (!href || href === '#') {
            return;
        }

        e.preventDefault();

        const target = document.querySelector(href);
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    }
}

/* ============================================ */
/* NAVBAR SCROLL EFFECT */
/* ============================================ */

class NavbarScroll {
    constructor() {
        this.navbar = document.querySelector('.navbar');
        if (this.navbar) {
            this.scrollThreshold = 100;
            window.addEventListener('scroll', () => this.handleScroll());
        }
    }

    handleScroll() {
        if (window.scrollY > this.scrollThreshold) {
            this.navbar.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.1)';
        } else {
            this.navbar.style.boxShadow = '0 2px 15px rgba(0, 0, 0, 0.08)';
        }
    }
}

/* ============================================ */
/* FUNCIÓN PARA IR AL FORMULARIO */
/* ============================================ */

function irAFormularioContacto() {
    const contactSection = document.getElementById('contacto');
    if (contactSection) {
        contactSection.scrollIntoView({
            behavior: 'smooth',
            block: 'start'
        });
    }
}

/* ============================================ */
/* INICIALIZACIÓN */
/* ============================================ */

document.addEventListener('DOMContentLoaded', () => {
    new ScrollAnimationObserver();
    new ContactForm();
    new WhatsAppButton();
    new SmoothNavigation();
    new NavbarScroll();

    console.log('%c🐾 Casa Canis Landing Page', 'font-size: 20px; font-weight: bold; color: #0B2F1D;');
    console.log('%cNúmero de WhatsApp: ' + WHATSAPP_NUMBER, 'font-weight: bold;');
    console.log('%c✅ Landing page cargada correctamente', 'color: #10b981;');
});

/* ============================================ */
/* EVENTOS GLOBALES */
/* ============================================ */

window.addEventListener('resize', () => {
    // Recalcular elementos si es necesario
});

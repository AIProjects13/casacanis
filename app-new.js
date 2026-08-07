/* ============================================ */
/* CONFIGURACIÓN GLOBAL */
/* ============================================ */

const WHATSAPP_NUMBER = '+502 5555 5555';
const WHATSAPP_API = 'https://wa.me/50255555555';

let carrito = [];

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
        const animatedElements = document.querySelectorAll('.fade-in, .fade-in-up, .fade-in-left, .producto-categoria, .servicio-especial');
        animatedElements.forEach(element => {
            this.observer.observe(element);
        });
    }
}

/* ============================================ */
/* CARRITO DE COMPRAS (PedidosYa Style) */
/* ============================================ */

class CarritoManager {
    constructor() {
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Botones de cantidad
        const minusButtons = document.querySelectorAll('.qty-btn.minus');
        const plusButtons = document.querySelectorAll('.qty-btn.plus');
        const qtyInputs = document.querySelectorAll('.qty-input');

        minusButtons.forEach((btn, index) => {
            btn.addEventListener('click', () => this.decrementQty(index));
        });

        plusButtons.forEach((btn, index) => {
            btn.addEventListener('click', () => this.incrementQty(index));
        });

        qtyInputs.forEach((input, index) => {
            input.addEventListener('change', () => this.updateQty(index));
        });
    }

    incrementQty(index) {
        const input = document.querySelectorAll('.qty-input')[index];
        let value = parseInt(input.value) || 0;
        input.value = value + 1;
        this.updateCarrito();
    }

    decrementQty(index) {
        const input = document.querySelectorAll('.qty-input')[index];
        let value = parseInt(input.value) || 0;
        if (value > 0) {
            input.value = value - 1;
            this.updateCarrito();
        }
    }

    updateQty(index) {
        this.updateCarrito();
    }

    updateCarrito() {
        carrito = [];

        const productos = document.querySelectorAll('.producto-item');
        productos.forEach((producto, index) => {
            const input = document.querySelectorAll('.qty-input')[index];
            const cantidad = parseInt(input.value) || 0;

            if (cantidad > 0) {
                const nombre = producto.querySelector('.producto-info h4').textContent;
                const precioText = producto.querySelector('.precio').textContent;
                const precio = parseFloat(precioText.replace('Q', '').replace(',', ''));

                carrito.push({
                    nombre: nombre,
                    cantidad: cantidad,
                    precio: precio,
                    total: precio * cantidad
                });
            }
        });

        this.renderCarrito();
    }

    renderCarrito() {
        const carritoItems = document.getElementById('carrito-items');
        const subtotal = document.getElementById('subtotal');
        const total = document.getElementById('total');

        carritoItems.innerHTML = '';

        if (carrito.length === 0) {
            carritoItems.innerHTML = '<p class="empty-cart">No hay servicios seleccionados</p>';
            subtotal.textContent = 'Q0.00';
            total.textContent = 'Q0.00';
            return;
        }

        let totalAmount = 0;
        carrito.forEach(item => {
            totalAmount += item.total;
            const itemHTML = `
                <div class="carrito-item">
                    <div>
                        <div class="carrito-item-name">${item.nombre}</div>
                        <div class="carrito-item-qty">Cantidad: ${item.cantidad}</div>
                    </div>
                    <div class="carrito-item-price">Q${item.total.toFixed(2)}</div>
                </div>
            `;
            carritoItems.innerHTML += itemHTML;
        });

        subtotal.textContent = `Q${totalAmount.toFixed(2)}`;
        total.textContent = `Q${totalAmount.toFixed(2)}`;
    }
}

/* ============================================ */
/* FORMULARIO DE CONTACTO */
/* ============================================ */

class ContactForm {
    constructor() {
        this.form = document.getElementById('contactForm');
        if (this.form) {
            this.form.addEventListener('submit', (e) => this.handleSubmit(e));
        }
    }

    handleSubmit(e) {
        e.preventDefault();

        const formData = {
            nombre: document.getElementById('nombre').value.trim(),
            telefono: document.getElementById('telefono').value.trim(),
            email: document.getElementById('email').value.trim(),
            mascota: document.getElementById('mascota').value.trim(),
            raza: document.getElementById('raza').value.trim(),
            peso: document.getElementById('peso').value.trim(),
            mensaje: document.getElementById('mensaje').value.trim()
        };

        if (!this.validateForm(formData)) {
            alert('Por favor completa todos los campos requeridos.');
            return;
        }

        const whatsappMessage = this.buildMessage(formData);
        this.openWhatsApp(whatsappMessage);
        this.form.reset();
    }

    validateForm(data) {
        return data.nombre && data.telefono && data.mascota;
    }

    buildMessage(data) {
        let message = `*NUEVA RESERVA - Casa Canis* 📱\n\n`;
        message += `👤 *Cliente:* ${data.nombre}\n`;
        message += `📞 *Teléfono:* ${data.telefono}\n`;

        if (data.email) {
            message += `📧 *Email:* ${data.email}\n`;
        }

        message += `\n🐕 *Información de Mascota*\n`;
        message += `Nombre: ${data.mascota}\n`;

        if (data.raza) {
            message += `Raza: ${data.raza}\n`;
        }

        if (data.peso) {
            message += `Peso: ${data.peso} lb\n`;
        }

        if (data.mensaje) {
            message += `\n💬 *Necesidades Especiales:*\n${data.mensaje}\n`;
        }

        message += `\n📋 *Servicios Seleccionados:*\n`;
        if (carrito.length > 0) {
            carrito.forEach(item => {
                message += `• ${item.nombre} (x${item.cantidad}) - Q${item.total.toFixed(2)}\n`;
            });
            message += `\n*TOTAL: Q${carrito.reduce((sum, item) => sum + item.total, 0).toFixed(2)}*\n`;
        } else {
            message += `Consulta general sobre servicios\n`;
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
    new CarritoManager();
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

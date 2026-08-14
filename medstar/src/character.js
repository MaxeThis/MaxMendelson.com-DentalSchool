/**
 * Corner greeter: a placeholder stick figure peeks out of the bottom-left
 * corner. Clicking it slides the figure up and pops a speech bubble with
 * the externship thank-you note.
 *
 * The markup lives in index.html (#character). To swap in the real photo
 * later, replace the inline SVG inside .character-figure with
 * `<img src="public/character.png" alt="Max">` — every animation is CSS
 * driven off the wrapper classes, so nothing here changes.
 */
export function createCharacter() {
    const root = document.getElementById('character');
    if (!root) return { isOpen: false, close: () => {} };

    const figure = root.querySelector('.character-figure');
    const bubble = root.querySelector('.character-bubble');
    const close = root.querySelector('.bubble-close');
    let open = false;

    function setOpen(next) {
        open = next;
        root.classList.toggle('open', open);
        if (open) bubble.hidden = false;
        else window.setTimeout(() => { if (!open) bubble.hidden = true; }, 350);
    }

    const contactButton = root.querySelector('#btn-contact');
    const contactCard = root.querySelector('#contact-card');
    contactButton?.addEventListener('click', () => {
        contactCard.hidden = !contactCard.hidden;
    });

    figure.addEventListener('click', () => {
        if (open) contactCard.hidden = true;
        setOpen(!open);
    });
    close.addEventListener('click', event => {
        event.stopPropagation();
        setOpen(false);
    });
    window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && open) setOpen(false);
    });

    return {
        get isOpen() { return open; },
        open: () => setOpen(true),
        close: () => setOpen(false),
        setVisible(visible) {
            if (!visible && open) setOpen(false);
            if (visible && root.hidden) {
                // Restart the entrance animation on each appearance.
                root.classList.remove('arrive');
                void root.offsetWidth;
                root.classList.add('arrive');
            }
            root.hidden = !visible;
        }
    };
}

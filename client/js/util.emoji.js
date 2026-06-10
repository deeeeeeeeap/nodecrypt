// Emoji picker setup. The heavy picker bundle is loaded only when first opened.
import {
	$,
	on
} from './util.dom.js';

let emojiPickerLoad = null;

function loadEmojiPickerElement() {
	if (!emojiPickerLoad) {
		emojiPickerLoad = import('emoji-picker-element')
	}
	return emojiPickerLoad
}

function addEmojiPickerStyles() {
	if (document.querySelector('#emoji-picker-styles')) return;
	const style = document.createElement('style');
	style.id = 'emoji-picker-styles';
	style.textContent = `emoji-picker{--background:#fff;--border-color:rgba(0,0,0,0.1);--border-radius:10px;--emoji-padding:0.4rem;--category-emoji-size:1.2rem;--font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;position:absolute;bottom:60px;left:22px;z-index:5;box-shadow:0 3px 12px rgba(0,0,0,0.15);display:none;opacity:0;transform:translateY(-10px) scale(0.95);transition:opacity 0.3s ease,transform 0.3s ease}emoji-picker.show{opacity:1;transform:translateY(0) scale(1)}`;
	document.head.appendChild(style)
}

export function setupEmojiPicker({
	btnSelector = '.chat-emoji-btn',
	inputSelector = '.input-message-input'
} = {}) {
	const btn = $(btnSelector);
	const input = $(inputSelector);
	if (!btn || !input) return;

	let picker = null;
	let loading = false;

	function showPickerWithAnimation() {
		if (!picker) return;
		picker.style.display = 'block';
		picker.offsetHeight;
		picker.classList.add('show')
	}

	function hidePickerWithAnimation() {
		if (!picker) return;
		picker.classList.remove('show');
		setTimeout(() => {
			if (picker) picker.style.display = 'none'
		}, 300)
	}

	async function ensurePicker() {
		if (picker) return picker;
		if (loading) {
			await loadEmojiPickerElement();
			return picker
		}

		loading = true;
		try {
			await loadEmojiPickerElement();
			addEmojiPickerStyles();
			const oldPicker = $('emoji-picker', btn.parentNode);
			if (oldPicker) oldPicker.remove();
			picker = document.createElement('emoji-picker');
			picker.style.display = 'none';
			btn.parentNode.style.position = 'relative';
			btn.parentNode.appendChild(picker);
			picker.addEventListener('emoji-click', event => {
				insertEmoji(input, event.detail.unicode);
				hidePickerWithAnimation()
			});
		} finally {
			loading = false
		}
		return picker
	}

	on(btn, 'click', async (ev) => {
		ev.stopPropagation();
		btn.disabled = true;
		try {
			await ensurePicker();
		} catch (error) {
			console.error('Failed to initialize emoji picker:', error)
		} finally {
			btn.disabled = false
		}
		if (!picker) return;
		if (picker.style.display === 'none') {
			showPickerWithAnimation()
		} else {
			hidePickerWithAnimation()
		}
	});

	on(document, 'click', (ev) => {
		if (picker && !picker.contains(ev.target) && ev.target !== btn) {
			hidePickerWithAnimation()
		}
	})
}

function insertEmoji(input, emoji) {
	input.focus();
	if (document.getSelection && window.getSelection) {
		let sel = window.getSelection();
		if (!sel.rangeCount) return;
		let range = sel.getRangeAt(0);
		range.deleteContents();
		range.insertNode(document.createTextNode(emoji));
		range.collapse(false);
		sel.removeAllRanges();
		sel.addRange(range)
	} else {
		input.innerText += emoji
	}
	input.dispatchEvent(new Event('input'))
}

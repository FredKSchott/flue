import { mount } from "@cloudflare/nimbus-docs/client";

function cloneIcon(tpl: HTMLTemplateElement | null): Node {
  return tpl ? tpl.content.cloneNode(true) : document.createTextNode("");
}

function createSpacer(): HTMLElement {
  const span = document.createElement("span");
  span.className = "ft-sp";
  span.setAttribute("aria-hidden", "true");
  return span;
}

function createEmptyIcon(): HTMLElement {
  const span = document.createElement("span");
  span.className = "ft-icon";
  span.setAttribute("aria-hidden", "true");
  return span;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getSafeLabel(nodes: ChildNode[], stripTrailingSlash = false): string {
  return nodes
    .map((node) => {
      let text = node.textContent ?? "";
      if (stripTrailingSlash) {
        text = text.replace(/\/\s*$/, "");
      }
      text = text.trim();
      if (!text) return "";

      if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "STRONG") {
        return `<strong>${escapeHtml(text)}</strong>`;
      }

      return escapeHtml(text);
    })
    .join("");
}

function createLabel(label: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const sep = label.indexOf(" # ");
  const nameHtml = (sep === -1 ? label : label.slice(0, sep)).replace(/\/\s*$/, "").trimEnd();

  const name = document.createElement("span");
  name.className = "ft-label";
  name.innerHTML = nameHtml;
  frag.appendChild(name);

  if (sep !== -1) {
    const commentHtml = label.slice(sep + 1).trim();
    if (commentHtml) {
      const comment = document.createElement("span");
      comment.className = "ft-comment";
      comment.innerHTML = commentHtml;
      frag.appendChild(comment);
    }
  }

  return frag;
}

mount("[data-file-tree]", (tree) => {
  const chevTpl = tree.querySelector<HTMLTemplateElement>("[data-ft-icon-chev]");
  const folderTpl = tree.querySelector<HTMLTemplateElement>("[data-ft-icon-folder]");
  const fileTpl = tree.querySelector<HTMLTemplateElement>("[data-ft-icon-file]");

  for (const li of tree.querySelectorAll("li")) {
    const childUl = li.querySelector<HTMLUListElement>(":scope > ul");
    const text = li.textContent?.trim() ?? "";

    if (text === "..." || text === "…") {
      li.setAttribute("data-placeholder", "");
      li.replaceChildren(createSpacer(), createEmptyIcon(), createLabel("⋯"));
      continue;
    }

    if (childUl) {
      const label = getSafeLabel(
        [...li.childNodes].filter((node) => node !== childUl),
        true,
      );

      const details = document.createElement("details");
      details.open = true;
      const summary = document.createElement("summary");
      summary.appendChild(cloneIcon(chevTpl));
      summary.appendChild(cloneIcon(folderTpl));
      summary.appendChild(createLabel(label));
      details.appendChild(summary);
      details.appendChild(childUl);
      li.replaceChildren(details);
    } else {
      li.setAttribute("data-file", "");
      const label = getSafeLabel([...li.childNodes]);
      li.replaceChildren(createSpacer(), cloneIcon(fileTpl), createLabel(label));
    }
  }

  // Init only transforms the DOM once (native <details> handles expand/collapse);
  // it registers no listeners, so there is nothing to tear down.
  return () => {};
});

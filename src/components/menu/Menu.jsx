import React from 'react';

import './Menu.css';

export default () => (
    <ul className="menu">
        <li className="menu-item">
            <a href="/">
                Inicio
            </a>
        </li>
        <li className="menu-item">
            <a href="/ativos">
                Ativos
            </a>
        </li>
        <li className="menu-item">
            <a href="/ordens">
                Ordens
            </a>
        </li>
    </ul>
);
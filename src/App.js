import React, { Component } from 'react';
import { Router, Route, browserHistory, Redirect } from 'react-router';
import './App.css';

import Menu from './components/menu/Menu'
import Inicio from './pages/Inicio';
import Ativos from './pages/Ativos';
import Ordens from './pages/Ordens';

class App extends Component {
  render() {
    return (
      <div id="application">
        <Menu />
        <Router history={browserHistory}>
          <Route path="/inicio" component={Inicio} />
          <Route path="/ordens" component={Ordens} />
          <Route path="/ativos" component={Ativos} />
          <Redirect from='*' to="/inicio" />
        </Router>
      </div>
    );
  }
}

export default App;
